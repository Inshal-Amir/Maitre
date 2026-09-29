import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import type { AttachmentKind } from '../shared/types';
import { ToolError } from './tools/types';

const MAX_FILE_BYTES = 50_000_000;
const MAX_TEXT_CHARS = 400_000;
const IMAGE = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;
const OFFICE_UNSUPPORTED = /\.(pptx?|xlsx?|doc|odt|pages|key|numbers)$/i;

export interface ExtractedDocument {
  kind: AttachmentKind;
  text: string;
  pages?: number;
  truncated: boolean;
}

const isBinary = (buffer: Buffer): boolean => buffer.subarray(0, 8000).includes(0);

export const isDocumentPath = (file: string): boolean => /\.(pdf|docx)$/i.test(file);

function cap(text: string): { text: string; truncated: boolean } {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  return clean.length > MAX_TEXT_CHARS ? { text: clean.slice(0, MAX_TEXT_CHARS), truncated: true } : { text: clean, truncated: false };
}

async function readPdf(buffer: Buffer): Promise<ExtractedDocument> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const joined = text.map((page, index) => `--- page ${index + 1} ---\n${page.trim()}`).join('\n\n');
  const readable = text.join('').replace(/\s/g, '').length;
  if (!readable) throw new ToolError('This PDF has no text layer (it is probably a scanned image). Run it through OCR first, or copy the text into the chat.');
  return { kind: 'pdf', pages: totalPages, ...cap(joined) };
}

/** Plain text from a PDF, a Word .docx or any text/code file; images and other binary formats are refused with a clear reason. */
export async function extractDocument(file: string): Promise<ExtractedDocument> {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) throw new ToolError(`${path.basename(file)} is a folder.`);
  if (stat.size > MAX_FILE_BYTES) throw new ToolError(`${path.basename(file)} is larger than 50 MB.`);
  if (IMAGE.test(file)) throw new ToolError('Images cannot be read yet: the Zehnora model understands text only.');
  if (OFFICE_UNSUPPORTED.test(file)) throw new ToolError(`${path.extname(file)} files are not supported yet; save it as PDF or .docx.`);
  const buffer = fs.readFileSync(file);
  if (/\.pdf$/i.test(file)) return readPdf(buffer);
  if (/\.docx$/i.test(file)) {
    const { value } = await mammoth.extractRawText({ buffer });
    return { kind: 'docx', ...cap(value) };
  }
  if (isBinary(buffer)) throw new ToolError(`${path.basename(file)} is a binary file and cannot be read as text.`);
  return { kind: 'text', ...cap(buffer.toString('utf8')) };
}
