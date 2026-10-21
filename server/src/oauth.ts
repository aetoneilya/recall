// OAuth 2.1 authorization server for claude.ai connectors, on top of the MCP
// SDK's router. Clients, codes and tokens live in SQLite; codes and tokens
// are stored as SHA-256 hashes and bound to the user who approved them.
import { randomBytes } from 'node:crypto'
import type { Response } from 'express'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { checkPassword, LoginLimiter, randomToken, sessionUser, sha256, verifyBearer } from './auth.ts'
import type { AppContext } from './context.ts'
import type { Db } from './db.ts'
import { ownerUser, type User } from './users.ts'

const CODE_TTL_S = 10 * 60
const ACCESS_TTL_S = 60 * 60
const REFRESH_TTL_S = 90 * 86400

interface TokenRow {
  kind: 'access' | 'refresh'
  user_id: string
  client_id: string
  scopes: string
  resource: string | null
  expires_at: string
}

export class SqliteOAuthProvider implements OAuthServerProvider {
  ctx: AppContext
  db: Db
  limiter: LoginLimiter
  clientsStore: OAuthRegisteredClientsStore

  constructor(ctx: AppContext, limiter: LoginLimiter) {
    const db = ctx.db
    this.ctx = ctx
    this.db = db
    this.limiter = limiter
    this.clientsStore = {
      getClient: (clientId) => {
        const row = db.prepare('SELECT info FROM oauth_clients WHERE client_id = ?').get(clientId) as { info: string } | undefined
        return row ? (JSON.parse(row.info) as OAuthClientInformationFull) : undefined
      },
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull
        db.prepare('INSERT INTO oauth_clients(client_id, info, created_at) VALUES (?, ?, ?)').run(full.client_id, JSON.stringify(full), new Date().toISOString())
        return full
      },
    }
  }

  // Both GET (show the consent page) and POST (the page's form) land here;
  // the SDK has already validated client_id, redirect_uri and PKCE params.
  // Approve needs a session (from the bot login, possibly done on this very
  // page); the owner password is the fallback when Telegram is unreachable.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const req = res.req
    const now = this.ctx.now()
    const user = sessionUser(this.ctx, req)
    const scriptNonce = randomBytes(16).toString('base64')
    res.setHeader('Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; frame-ancestors 'none'`)
    const page = (error?: string) => consentPage(client, params, { user, botUsername: this.ctx.telegram.botUsername, scriptNonce, error })
    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, string>
      const back = new URL(params.redirectUri)
      if (params.state !== undefined) back.searchParams.set('state', params.state)
      if (body.decision === 'deny') {
        back.searchParams.set('error', 'access_denied')
        res.redirect(302, back.href)
        return
      }
      let approver: User | null = null
      if (body.decision === 'approve') {
        approver = user
        if (!approver) {
          res.status(401).type('html').send(page('Your sign-in has expired. Confirm in Telegram again.'))
          return
        }
      } else {
        const ip = req.ip ?? 'unknown'
        if (this.limiter.blocked(ip)) {
          res.status(429).type('html').send(page('Too many attempts. Try again later.'))
          return
        }
        approver = checkPassword(this.ctx.cfg, body.password) ? ownerUser(this.db, this.ctx.cfg, now) : null
        if (!approver) {
          this.limiter.fail(ip)
          res.status(401).type('html').send(page('Wrong password.'))
          return
        }
        this.limiter.clear(ip)
      }
      const code = randomToken()
      this.db.prepare(
        'INSERT INTO oauth_codes(code, user_id, client_id, code_challenge, redirect_uri, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(sha256(code), approver.id, client.client_id, params.codeChallenge, params.redirectUri, (params.scopes ?? []).join(' '),
        params.resource?.href ?? null, new Date(now.getTime() + CODE_TTL_S * 1000).toISOString())
      back.searchParams.set('code', code)
      res.redirect(302, back.href)
      return
    }
    res.type('html').send(page())
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.loadCode(client, code).code_challenge
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const row = this.loadCode(client, code)
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match the authorization request')
    // Single use.
    this.db.prepare('DELETE FROM oauth_codes WHERE code = ?').run(sha256(code))
    return this.issue(row.user_id, client.client_id, row.scopes, row.resource)
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const hash = sha256(refreshToken)
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(hash) as TokenRow | undefined
    if (!row || row.kind !== 'refresh' || row.client_id !== client.client_id || row.expires_at <= this.ctx.now().toISOString()) {
      throw new InvalidGrantError('invalid refresh token')
    }
    // Rotation: a refresh token works once.
    this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(hash)
    return this.issue(row.user_id, client.client_id, row.scopes, row.resource)
  }

  // Every bearer /mcp accepts: MCP_TOKEN, personal tokens and OAuth access
  // tokens. The user travels in extra.userId.
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const b = verifyBearer(this.ctx, token)
    if (!b) throw new InvalidTokenError('invalid or expired token')
    const info: AuthInfo = { token, clientId: b.clientId, scopes: b.scopes, expiresAt: b.expiresAt, extra: { userId: b.user.id } }
    if (b.resource) info.resource = new URL(b.resource)
    return info
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ?').run(sha256(request.token), client.client_id)
  }

  private loadCode(client: OAuthClientInformationFull, code: string) {
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(sha256(code)) as
      | { user_id: string; client_id: string; code_challenge: string; redirect_uri: string; scopes: string; resource: string | null; expires_at: string }
      | undefined
    if (!row || row.client_id !== client.client_id || row.expires_at <= this.ctx.now().toISOString()) throw new InvalidGrantError('invalid authorization code')
    return row
  }

  private issue(userId: string, clientId: string, scopes: string, resource: string | null): OAuthTokens {
    const now = this.ctx.now().getTime()
    this.db.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(new Date(now).toISOString())
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(new Date(now).toISOString())
    const access = randomToken()
    const refresh = randomToken()
    const insert = this.db.prepare('INSERT INTO oauth_tokens(token_hash, kind, user_id, client_id, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run(sha256(access), 'access', userId, clientId, scopes, resource, new Date(now + ACCESS_TTL_S * 1000).toISOString())
    insert.run(sha256(refresh), 'refresh', userId, clientId, scopes, resource, new Date(now + REFRESH_TTL_S * 1000).toISOString())
    const tokens: OAuthTokens = { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh }
    if (scopes) tokens.scope = scopes
    return tokens
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

interface PageOptions {
  user: User | null
  botUsername: string | null
  scriptNonce: string
  error?: string
}

function consentPage(client: OAuthClientInformationFull, p: AuthorizationParams, o: PageOptions): string {
  const hidden: Record<string, string | undefined> = {
    client_id: client.client_id,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
    scope: p.scopes?.length ? p.scopes.join(' ') : undefined,
    state: p.state,
    resource: p.resource?.href,
  }
  const inputs = Object.entries(hidden)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v!)}">`)
    .join('')
  const name = esc(client.client_name || client.client_id)
  const deny = '<button name="decision" value="deny" formnovalidate>Deny</button>'
  let body: string
  if (o.user) {
    const who = o.user.name ? `, ${esc(o.user.name)}` : ''
    body = `<h1>Allow ${name} to manage your cards${who}?</h1>
<p>It will be able to read, add and edit words in your Mnemosyne vocabulary.</p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ''}
<button name="decision" value="approve" class="primary">Approve</button>
${deny}`
  } else {
    // Telegram first; the owner password stays as a fallback below it.
    const telegram = o.botUsername
      ? `<button type="button" id="tg" class="primary">Confirm in Telegram</button>
<p id="tg-wait" hidden>Open <a id="tg-link" href="#" target="_blank" rel="noopener">@${esc(o.botUsername)}</a> in Telegram, press Start, then tap ✅ Log in. This page continues by itself.</p>
<p id="tg-err" class="err" hidden></p>`
      : ''
    body = `<h1>Allow ${name} to manage your cards?</h1>
<p>It will be able to read, add and edit words in your Mnemosyne vocabulary.</p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ''}
${telegram}
<details${o.botUsername ? '' : ' open'}><summary>Owner password</summary>
<input type="password" name="password" placeholder="Password" autocomplete="current-password">
<button name="decision" value="password">Approve with password</button>
</details>
${deny}`
  }
  const script = o.user || !o.botUsername ? '' : `<script nonce="${o.scriptNonce}">
(() => {
  const $ = (id) => document.getElementById(id)
  const fail = (msg) => { $('tg-err').textContent = msg; $('tg-err').hidden = false; $('tg').disabled = false }
  $('tg').addEventListener('click', async () => {
    $('tg').disabled = true
    $('tg-err').hidden = true
    let start
    try {
      const r = await fetch('/api/login/telegram', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (!r.ok) return fail(r.status === 429 ? 'Too many attempts. Try again later.' : 'Telegram login is unavailable.')
      start = await r.json()
    } catch { return fail('Network error.') }
    $('tg-link').href = start.url
    $('tg-wait').hidden = false
    const poll = async () => {
      let r
      try { r = await fetch('/api/login/telegram/' + encodeURIComponent(start.nonce)) } catch { return setTimeout(poll, 3000) }
      if (r.status === 202) return setTimeout(poll, 2000)
      if (r.status !== 200) { $('tg-wait').hidden = true; return fail('The link expired. Try again.') }
      // Signed in: the session cookie is set, approve as that user.
      const form = document.querySelector('form')
      const d = document.createElement('input')
      d.type = 'hidden'; d.name = 'decision'; d.value = 'approve'
      form.append(d)
      form.submit()
    }
    setTimeout(poll, 2000)
  })
})()
</script>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mnemosyne · authorize</title><style>
body{font:16px/1.4 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f4;color:#1d1d1b}
@media (prefers-color-scheme:dark){body{background:#151514;color:#eee}input{background:#222;color:#eee;border-color:#444}a{color:#8fc9a9}}
form{max-width:340px;width:calc(100% - 32px);display:grid;gap:12px}details{display:grid;gap:8px}details[open]{display:grid}
summary{cursor:pointer;opacity:.8}details input,details button{display:block;width:100%;box-sizing:border-box;margin-top:8px}
h1{font-size:20px;margin:0}p{margin:0;opacity:.8}input{font:inherit;padding:10px;border:1px solid #ccc;border-radius:8px}
button{font:inherit;padding:10px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}
.primary{background:#2f6f4f;border-color:#2f6f4f;color:#fff}.err{color:#c0392b;opacity:1}
</style></head><body><form method="post">${inputs}
${body}
</form>${script}</body></html>`
}
