// A small Markdown renderer for fact cards: paragraphs and line breaks,
// "-" / "1." lists, **bold**, *em*, `code`, ``` fenced blocks, headings as
// bold lines, and Obsidian [[target|alias]] wikilinks as emphasised text.
// Everything the source says is escaped before any tag is added, and the
// only tags and attributes are the ones written here, so the result is safe
// for {@html}. No links, images or raw HTML.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]!)
}

// [[Note]], [[Note|shown]], [[Note#Section]] → what Obsidian would show.
function wikiText(inner: string): string {
  const [target, alias] = inner.split('|', 2)
  const t = alias?.trim() || target!.trim().replace(/#/g, ' › ').replace(/^.*\//, '')
  return t
}

// Inline formatting of one line or list item. Code spans and wikilinks are
// cut out first so nothing inside them is formatted.
export function renderInline(src: string): string {
  let out = ''
  const re = /(`+)([\s\S]*?[^`])\1(?!`)|\[\[([^\][\n]+)\]\]/g
  let last = 0
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out += emphasis(escapeHtml(src.slice(last, m.index)))
    if (m[3] !== undefined) out += `<em class="wl">${escapeHtml(wikiText(m[3]))}</em>`
    else out += `<code>${escapeHtml(m[2]!.replace(/^ (.*) $/, '$1'))}</code>`
    last = m.index + m[0].length
  }
  return out + emphasis(escapeHtml(src.slice(last)))
}

// On already escaped text: ** / __ strong, * / _ emphasis. Underscores only
// at word edges, so snake_case stays as it is.
function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, '<strong>$1</strong>')
    .replace(/(?<![*\\])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/gu, '<em>$1</em>')
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: { ordered: boolean; start: number; items: string[][] } | null = null

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(renderInline).join('<br>')}</p>`)
    para = []
  }
  const flushList = () => {
    if (!list) return
    const tag = list.ordered ? 'ol' : 'ul'
    const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : ''
    out.push(`<${tag}${start}>${list.items.map((it) => `<li>${it.map(renderInline).join('<br>')}</li>`).join('')}</${tag}>`)
    list = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      flushPara()
      flushList()
      const close = new RegExp(`^ {0,3}${fence[1]![0] === '`' ? '`' : '~'}{${fence[1]!.length},}\\s*$`)
      const body: string[] = []
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!)
      const lang = fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : ''
      out.push(`<pre${lang}><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) {
      flushPara()
      // A blank line ends a list unless the next line carries on with it.
      const next = lines.slice(i + 1).find((l) => l.trim())
      if (list && !(next && ITEM.exec(next) && isOrdered(next) === list.ordered)) flushList()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flushPara()
      flushList()
      out.push(`<p><strong>${renderInline(heading[1]!)}</strong></p>`)
      continue
    }
    if (RULE.test(line)) {
      flushPara()
      flushList()
      out.push('<hr>')
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      flushPara()
      const ordered = isOrdered(line)
      if (list && list.ordered !== ordered && !item[1]) flushList()
      if (!list) list = { ordered, start: ordered ? parseInt(item[2]!, 10) : 1, items: [] }
      list.items.push([item[3]!])
      continue
    }
    // An indented line under a list item continues it.
    if (list && /^\s+\S/.test(line) && !para.length) {
      list.items.at(-1)!.push(line.trim())
      continue
    }
    flushList()
    para.push(line.trim())
  }
  flushPara()
  flushList()
  return out.join('')
}

function isOrdered(line: string): boolean {
  return /^\s*\d/.test(line)
}
