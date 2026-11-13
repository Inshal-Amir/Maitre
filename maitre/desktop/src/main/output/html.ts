import { Marked } from 'marked';

const marked = new Marked({ gfm: true, breaks: false });

const escape = (text: string): string => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);

/** Markdown as an HTML fragment (Google Docs import, PDF body). */
export const markdownHtml = (markdown: string): string => marked.parse(markdown, { async: false });

const STYLE = `
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Roboto, Arial, "Noto Nastaliq Urdu", sans-serif; font-size: 10.5pt; line-height: 1.55; color: #1c2420; }
:is(p, li, h1, h2, h3, h4, blockquote, td, th) { unicode-bidi: plaintext; text-align: start; }
.doc-title { font-size: 22pt; line-height: 1.2; margin: 0 0 4pt; color: #1f4a3d; }
.doc-rule { height: 3px; width: 56px; background: #a9541f; border: 0; margin: 0 0 16pt; }
h1 { font-size: 17pt; color: #1f4a3d; margin: 18pt 0 6pt; }
h2 { font-size: 13.5pt; color: #1f4a3d; margin: 16pt 0 6pt; padding-bottom: 3pt; border-bottom: 1px solid #e3ddd0; }
h3 { font-size: 11.5pt; margin: 12pt 0 4pt; }
p { margin: 0 0 7pt; }
ul, ol { margin: 0 0 8pt; padding-inline-start: 18pt; }
li { margin: 2pt 0; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; font-size: 9.5pt; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th, td { border: 1px solid #d9d3c5; padding: 5pt 7pt; vertical-align: top; }
th { background: #f1ede3; font-weight: 600; }
code { font-family: Menlo, Consolas, monospace; font-size: 9pt; background: #f1ede3; padding: 1pt 3pt; border-radius: 3px; }
pre { background: #f6f3ec; padding: 8pt 10pt; border-radius: 6px; overflow: hidden; white-space: pre-wrap; direction: ltr; }
pre code { background: none; padding: 0; }
blockquote { margin: 0 0 8pt; padding: 2pt 10pt; border-inline-start: 3px solid #a9541f; color: #4a5751; }
hr { border: 0; border-top: 1px solid #e3ddd0; margin: 12pt 0; }
a { color: #1f4a3d; }
img { max-width: 100%; }
`;

/** A complete, print-ready HTML page for the PDF renderer. */
export function documentHtml(title: string, markdown: string): string {
  const body = markdownHtml(markdown);
  const startsWithTitle = /^\s*#\s/.test(markdown);
  const heading = startsWithTitle ? '' : `<h1 class="doc-title">${escape(title)}</h1><hr class="doc-rule">`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>${STYLE}</style></head><body dir="auto">${heading}${body}</body></html>`;
}
