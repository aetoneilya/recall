import { describe, expect, it } from 'vitest'
import { escapeHtml, renderInline, renderMarkdown } from './markdown.ts'

describe('renderMarkdown', () => {
  it('escapes everything before formatting', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
    expect(renderMarkdown('<script>alert(1)</script> **<b>hi</b>**')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; <strong>&lt;b&gt;hi&lt;/b&gt;</strong></p>')
    expect(renderMarkdown('[[x" onclick="y|<img src=x onerror=alert(1)>]]')).toBe('<p><em class="wl">&lt;img src=x onerror=alert(1)&gt;</em></p>')
    expect(renderMarkdown('```js" onload="x\ncode\n```')).not.toContain('onload="')
  })

  it('makes paragraphs and line breaks', () => {
    expect(renderMarkdown('One\ntwo\n\n\nThree')).toBe('<p>One<br>two</p><p>Three</p>')
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('# Title\nText')).toBe('<p><strong>Title</strong></p><p>Text</p>')
  })

  it('formats inline bold, emphasis and code, leaving code and snake_case alone', () => {
    expect(renderInline('**Bigger** is *not* better, __really__ _so_')).toBe('<strong>Bigger</strong> is <em>not</em> better, <strong>really</strong> <em>so</em>')
    expect(renderInline('`x++` is a **read-modify-write**')).toBe('<code>x++</code> is a <strong>read-modify-write</strong>')
    expect(renderInline('`**not bold**` and `a < b`')).toBe('<code>**not bold**</code> and <code>a &lt; b</code>')
    expect(renderInline('max_connections and cores × 2 * 3')).toBe('max_connections and cores × 2 * 3')
    expect(renderInline('**a *b* c**')).toBe('<strong>a <em>b</em> c</strong>')
    expect(renderInline('``code with ` tick``')).toBe('<code>code with ` tick</code>')
  })

  it('marks a first line that is only bold as the lead', () => {
    expect(renderMarkdown('**began · begun**\n\n*She began to cry.*\nОна заплакала.')).toBe(
      '<p><strong class="lead">began · begun</strong></p><p><em>She began to cry.</em><br>Она заплакала.</p>',
    )
    expect(renderMarkdown('**to begin**\nначинать')).toBe('<p><strong class="lead">to begin</strong><br>начинать</p>')
    // Not the lead: bold with more on the line, or bold further down.
    expect(renderMarkdown('**Bigger** is not better')).toBe('<p><strong>Bigger</strong> is not better</p>')
    expect(renderMarkdown('Intro\n\n**Alone**')).toBe('<p>Intro</p><p><strong>Alone</strong></p>')
    expect(renderMarkdown('**a** and **b**')).toBe('<p><strong>a</strong> and <strong>b</strong></p>')
  })

  it('renders wikilinks as emphasised text', () => {
    expect(renderInline('[[race condition]] [[Что такое race condition|race]] · [[Note#Part]]')).toBe(
      '<em class="wl">race condition</em> <em class="wl">race</em> · <em class="wl">Note › Part</em>',
    )
    expect(renderInline('[[a **b**]]')).toBe('<em class="wl">a **b**</em>')
  })

  it('renders bullet and numbered lists, with continuation lines', () => {
    expect(renderMarkdown('Fixes:\n- `synchronized`\n- atomics\n  (CAS)\n\nDone')).toBe(
      '<p>Fixes:</p><ul><li><code>synchronized</code></li><li>atomics<br>(CAS)</li></ul><p>Done</p>',
    )
    expect(renderMarkdown('1. read\n2. modify\n\n3. write')).toBe('<ol><li>read</li><li>modify</li><li>write</li></ol>')
    expect(renderMarkdown('3) three\n4) four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>')
    expect(renderMarkdown('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>')
  })

  it('keeps fenced code verbatim and escaped', () => {
    const md = 'Use it:\n\n```java\nif (a < b && c) {\n    x = **y**;\n}\n```\nAfter'
    expect(renderMarkdown(md)).toBe('<p>Use it:</p><pre data-lang="java"><code>if (a &lt; b &amp;&amp; c) {\n    x = **y**;\n}</code></pre><p>After</p>')
    // An unclosed fence runs to the end.
    expect(renderMarkdown('```\nopen')).toBe('<pre><code>open</code></pre>')
    expect(renderMarkdown('~~~\n```\n~~~')).toBe('<pre><code>```</code></pre>')
  })
})
