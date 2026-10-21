import fs from 'node:fs'
import path from 'node:path'
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import express, { type NextFunction, type Request, type Response } from 'express'
import { apiRouter } from './api.ts'
import { LoginLimiter } from './auth.ts'
import type { AppContext } from './context.ts'
import { handleMcp } from './mcp.ts'
import { SqliteOAuthProvider } from './oauth.ts'
import { HttpError } from './repo.ts'
import { allowedUser, ownerUser } from './users.ts'

export function createApp(ctx: AppContext) {
  const { cfg } = ctx
  const app = express()
  // Caddy (or another local proxy) sits in front; trust it for req.ip.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal')
  app.disable('x-powered-by')

  const limiter = new LoginLimiter()
  const provider = new SqliteOAuthProvider(ctx, limiter)
  const mcpUrl = new URL('/mcp', cfg.appOrigin)

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(cfg.appOrigin),
    resourceServerUrl: mcpUrl,
    resourceName: 'Mnemosyne',
  }))
  // Some clients look for resource metadata at the root as well.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({ resource: mcpUrl.href, authorization_servers: [new URL(cfg.appOrigin).href], resource_name: 'Mnemosyne' })
  })

  const mcpAuth = cfg.dev
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) })
  app.all('/mcp', express.json({ limit: '4mb' }), mcpAuth, (req, res, next) => {
    // verifyAccessToken put the user id in extra; re-check it is still allowed.
    const user = cfg.dev ? ownerUser(ctx.db, cfg, ctx.now()) : allowedUser(ctx.db, cfg, req.auth?.extra?.userId)
    if (!user) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    handleMcp(ctx, user, req, res).catch(next)
  })

  app.use('/api', express.json({ limit: '4mb' }), apiRouter(ctx, limiter))

  if (cfg.staticDir) {
    const dir = path.resolve(cfg.staticDir)
    const index = path.join(dir, 'index.html')
    app.use(express.static(dir, {
      index: false,
      setHeaders: (res, file) => {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      },
    }))
    // SPA fallback: any other GET that wants HTML gets the app shell.
    app.use((req, res, next) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.accepts('html') || !fs.existsSync(index)) return next()
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(index)
    })
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' })
  })

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, ...err.body })
      return
    }
    const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as Error).message })
      return
    }
    console.error(err)
    if (!res.headersSent) res.status(500).json({ error: 'internal error' })
  })

  return app
}
