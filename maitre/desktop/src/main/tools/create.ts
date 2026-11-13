import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { Tool, ToolContext } from './types';
import { ToolError, optStr, str } from './types';
import { markdownHtml } from '../output/html';
import { markdownDocx } from '../output/docx';
import { markdownPptx } from '../output/pptx';
import { htmlPdf, markdownPdf } from '../output/pdf';

type Format = 'pdf' | 'docx' | 'pptx' | 'md' | 'html';

const FORMATS: Format[] = ['pdf', 'docx', 'pptx', 'md', 'html'];

/** Where Chat mode saves the files it creates; Work mode saves into the working folder. */
export const outputDir = (context: ToolContext): string => (context.mode === 'work' ? context.cwd : path.join(os.homedir(), 'Documents', 'Maitre'));

const safeName = (name: string): string => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Document';

/** A path that does not overwrite an existing file: "Report.pdf", then "Report (2).pdf" and so on. */
function freePath(dir: string, base: string, ext: string): string {
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${base}${n > 1 ? ` (${n})` : ''}.${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

async function render(format: Format, title: string, content: string, html: boolean): Promise<Buffer> {
  if (format === 'pdf') return html ? htmlPdf(content) : markdownPdf(title, content);
  if (format === 'html' && html) return Buffer.from(content);
  if (format === 'docx') return markdownDocx(title, content);
  if (format === 'pptx') return markdownPptx(title, content);
  if (format === 'html') return Buffer.from(`<!doctype html><meta charset="utf-8"><title>${title}</title>${markdownHtml(content)}`);
  return Buffer.from(content);
}

/** Pandoc-style YAML front matter (title:, author:, ...) that some skills ask for; it would otherwise print as text. */
const FRONT_MATTER = /^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/;

const formatSize =(bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export const createFile: Tool = {
  name: 'create_file',
  description:
    'Create a finished document file on this computer and show it in the chat for the user to open: a PDF ("pdf"), Word document ("docx"), PowerPoint deck ("pptx"), Markdown or HTML. Use it whenever the user asks for a PDF, Word or PowerPoint file, report or presentation (instead of a Google Doc, unless they ask for Google). Always use the format the user asked for: if they asked for a PDF, the format is "pdf" even for a designed one. By default write the content in Markdown (headings, lists, tables, bold and links become real formatting). For a designed PDF with infographics, charts, shapes or a custom layout, set source to "html" and write one complete HTML page with inline CSS and inline SVG for every chart and shape (no scripts, no external images or fonts; use CSS page breaks between pages); it is printed to PDF exactly as designed. For "pptx" every # or ## heading starts a new slide; keep each slide to a few short bullets or one table.',
  parameters: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: FORMATS, description: 'File type' },
      title: { type: 'string', description: 'Document title; also the file name' },
      content: { type: 'string', description: 'The complete document: Markdown, or a full HTML page when source is "html"' },
      source: { type: 'string', enum: ['markdown', 'html'], description: 'What content is written in (default markdown); "html" is for designed PDFs with SVG charts and shapes' },
      file_name: { type: 'string', description: 'Optional file name without extension (defaults to the title)' },
    },
    required: ['format', 'title', 'content'],
  },
  modes: ['chat', 'work'],
  assess(args, context) {
    const format = optStr(args, 'format', 'pdf');
    const name = `${safeName(optStr(args, 'file_name') || optStr(args, 'title', 'Document'))}.${format}`;
    return { risk: 'normal', title: `Create ${name}`, detail: `Saves a new file in ${outputDir(context)}`, allowKey: 'create_file' };
  },
  async run(args, context) {
    const format = str(args, 'format') as Format;
    if (!FORMATS.includes(format)) throw new ToolError(`Unknown format "${format}". Use one of: ${FORMATS.join(', ')}.`);
    const title = str(args, 'title');
    const content = str(args, 'content');
    const dir = outputDir(context);
    fs.mkdirSync(dir, { recursive: true });
    const file = freePath(dir, safeName(optStr(args, 'file_name') || title), format);
    const html = optStr(args, 'source', 'markdown') === 'html';
    if (html && format !== 'pdf' && format !== 'html') throw new ToolError(`source "html" works for pdf and html files. For ${format}, write the content in Markdown.`);
    const data = await render(format, title, html ? content : content.replace(FRONT_MATTER, ''), html);
    fs.writeFileSync(file, data);
    return `Created ${file}\n${format.toUpperCase()}, ${formatSize(data.length)}. The user can open it from the card in the chat; mention the file name, do not paste the path as a link.`;
  },
};
