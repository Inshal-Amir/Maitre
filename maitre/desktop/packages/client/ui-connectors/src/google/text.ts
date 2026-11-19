/** Small text conversions the Google tools need: HTML to plain text and Markdown to import-ready HTML. */

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

/**
 * Decode HTML character references.
 * @param value - HTML-escaped text.
 * @returns plain text.
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (match, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
    if (name.startsWith('#') && name !== '#39') return String.fromCodePoint(Number(name.slice(1)))
    return ENTITIES[name.toLowerCase()] ?? match
  })
}

/**
 * Reduce an HTML document to readable text.
 * @param html - HTML source.
 * @returns text with block boundaries as line breaks.
 */
export function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
}

const cells = (row: string): string[] => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())

/**
 * Convert common Markdown (headings, lists, emphasis, links, code, tables) to
 * HTML for Drive's Google Docs import.
 * @param markdown - Markdown source.
 * @returns an HTML fragment.
 */
export function markdownHtml(markdown: string): string {
  const out: string[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let list: 'ul' | 'ol' | undefined
  const closeList = (): void => {
    if (list !== undefined) out.push(`</${list}>`)
    list = undefined
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (line.startsWith('```')) {
      closeList()
      const code: string[] = []
      for (index++; index < lines.length && !(lines[index] ?? '').startsWith('```'); index++) code.push(lines[index] ?? '')
      out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`)
    } else if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? '')) {
      closeList()
      const head = cells(line)
      const rows: string[][] = []
      for (index += 2; index < lines.length && (lines[index] ?? '').trim().startsWith('|'); index++) rows.push(cells(lines[index] ?? ''))
      index--
      out.push(`<table><tr>${head.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr>${rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</table>`)
    } else if (heading !== null) {
      closeList()
      const level = heading[1]?.length ?? 1
      out.push(`<h${String(level)}>${inline(heading[2] ?? '')}</h${String(level)}>`)
    } else if (bullet !== null || numbered !== null) {
      const kind = bullet !== null ? 'ul' : 'ol'
      if (list !== kind) {
        closeList()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline((bullet ?? numbered)?.[1] ?? '')}</li>`)
    } else if (line.trim() === '') {
      closeList()
    } else {
      closeList()
      out.push(`<p>${inline(line)}</p>`)
    }
  }
  closeList()
  return out.join('\n')
}

/**
 * Cut text to a character budget, noting the cut.
 * @param value - text.
 * @param max - maximum characters.
 * @returns the text, or its head with a truncation note.
 */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… [cut ${String(value.length - max)} characters]`
}
