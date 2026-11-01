import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import type { AttachmentKind } from '../shared/types';
import { ToolError } from './tools/types';

const MAX_FILE_BYTES = 50_000_000;
const MAX_TEXT_CHARS = 400_000;
const IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?)$/i;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
export const MAX_IMAGE_BYTES = 8_000_000;
const OFFICE_UNSUPPORTED = /\.(pptx?|xlsx?|doc|odt|pages|key|numbers)$/i;

export interface ExtractedDocument {
  kind: AttachmentKind;
  text: string;
  pages?: number;
  truncated: boolean;
}

const isBinary = (buffer: Buffer): boolean => buffer.subarray(0, 8000).includes(0);

export const isDocumentPath = (file: string): boolean => /\.(pdf|docx)$/i.test(file);

export const isImagePath = (file: string): boolean => IMAGE.test(file);

const imageType = (name: string): string | undefined => IMAGE_TYPES[path.extname(name).slice(1).toLowerCase()];

/** An image as a data URL the model can see; only PNG, JPEG, WebP and GIF up to 8 MB. */
export function imageDataUrl(name: string, bytes: Buffer): string {
  const mime = imageType(name);
  if (!mime) throw new ToolError(`${path.extname(name) || 'This'} images are not supported; save it as PNG or JPEG.`);
  if (bytes.length > MAX_IMAGE_BYTES) throw new ToolError(`${name} is larger than 8 MB; make it smaller or take a screenshot of the part that matters.`);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export function readImage(file: string): string {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) throw new ToolError(`${path.basename(file)} is a folder.`);
  if (stat.size > MAX_IMAGE_BYTES) throw new ToolError(`${path.basename(file)} is larger than 8 MB; make it smaller or take a screenshot of the part that matters.`);
  return imageDataUrl(path.basename(file), fs.readFileSync(file));
}

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

/** Plain text from a PDF, a Word .docx or any text/code file; images (see readImage) and other binary formats are refused with a clear reason. */
export async function extractDocument(file: string): Promise<ExtractedDocument> {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) throw new ToolError(`${path.basename(file)} is a folder.`);
  if (stat.size > MAX_FILE_BYTES) throw new ToolError(`${path.basename(file)} is larger than 50 MB.`);
  if (IMAGE.test(file)) throw new ToolError('This is an image, not text. Ask the user to attach it to the chat so Maitre can see it.');
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
