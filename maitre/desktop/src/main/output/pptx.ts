import PptxGenJS from 'pptxgenjs';
import { Lexer } from 'marked';
import type { Token, Tokens } from 'marked';

const BRAND = '1F4A3D';
const ACCENT = 'A9541F';
const INK = '1C2420';
const MUTED = '4A5751';
const PAPER = 'FAF8F3';
/** Body lines per slide before the rest continues on a new slide. */
const LINES_PER_SLIDE = 7;

interface Line {
  text: string;
  level: number;
  bullet: boolean;
}

interface SlideSpec {
  title: string;
  lines: Line[];
  tables: Tokens.Table[];
}

const decode = (text: string): string => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Plain text of inline Markdown (slides show text, not ** or ` marks). */
function plain(tokens: Token[] = []): string {
  return decode(tokens.map((token) => ('tokens' in token && Array.isArray(token.tokens) && token.tokens.length ? plain(token.tokens) : 'text' in token && typeof token.text === 'string' ? token.text : token.raw)).join(''));
}

function listLines(list: Tokens.List, level: number): Line[] {
  return list.items.flatMap((item) => [
    { text: plain(item.tokens.filter((token) => token.type !== 'list').flatMap((token) => ('tokens' in token && Array.isArray(token.tokens) ? token.tokens : [token]))), level, bullet: true },
    ...item.tokens.filter((token): token is Tokens.List => token.type === 'list').flatMap((child) => listLines(child, level + 1)),
  ]);
}

/** Splits Markdown into slides: every # or ## heading starts one; ### and deeper become bold lines. */
function slidesFrom(tokens: Token[], fallbackTitle: string): SlideSpec[] {
  const slides: SlideSpec[] = [];
  let current: SlideSpec | undefined;
  const ensure = (): SlideSpec => (current ??= (slides.push({ title: fallbackTitle, lines: [], tables: [] }), slides[slides.length - 1]));
  for (const token of tokens) {
    if (token.type === 'heading' && (token as Tokens.Heading).depth <= 2) {
      current = { title: plain((token as Tokens.Heading).tokens), lines: [], tables: [] };
      slides.push(current);
      continue;
    }
    if (token.type === 'heading') ensure().lines.push({ text: plain((token as Tokens.Heading).tokens), level: 0, bullet: false });
    else if (token.type === 'paragraph') ensure().lines.push({ text: plain((token as Tokens.Paragraph).tokens), level: 0, bullet: false });
    else if (token.type === 'list') ensure().lines.push(...listLines(token as Tokens.List, 0));
    else if (token.type === 'table') ensure().tables.push(token as Tokens.Table);
    else if (token.type === 'blockquote') ensure().lines.push({ text: plain((token as Tokens.Blockquote).tokens), level: 0, bullet: false });
    else if (token.type === 'code') ensure().lines.push(...(token as Tokens.Code).text.split('\n').slice(0, 12).map((text) => ({ text, level: 0, bullet: false })));
  }
  return slides.flatMap((slide) => {
    if (slide.lines.length <= LINES_PER_SLIDE) return [slide];
    const parts: SlideSpec[] = [];
    for (let i = 0; i < slide.lines.length; i += LINES_PER_SLIDE) {
      parts.push({ title: i ? `${slide.title} (cont.)` : slide.title, lines: slide.lines.slice(i, i + LINES_PER_SLIDE), tables: i ? [] : slide.tables });
    }
    return parts;
  });
}

function addTitleSlide(pptx: PptxGenJS, title: string, subtitle: string): void {
  const slide = pptx.addSlide();
  slide.background = { color: BRAND };
  slide.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.05, w: 1.1, h: 0.08, fill: { color: 'E9A273' }, line: { color: 'E9A273' } });
  slide.addText(title, { x: 0.8, y: 1.4, w: 11.7, h: 1.6, fontFace: 'Georgia', fontSize: 40, color: 'F3EEE3', bold: true, valign: 'bottom', fit: 'shrink' });
  if (subtitle) slide.addText(subtitle, { x: 0.8, y: 3.35, w: 11.7, h: 1.2, fontFace: 'Calibri', fontSize: 18, color: 'D8E4DC', valign: 'top', fit: 'shrink' });
}

function addContentSlide(pptx: PptxGenJS, spec: SlideSpec, number: number): void {
  const slide = pptx.addSlide();
  slide.background = { color: PAPER };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: BRAND }, line: { color: BRAND } });
  slide.addText(spec.title, { x: 0.7, y: 0.4, w: 11.9, h: 0.9, fontFace: 'Georgia', fontSize: 28, color: BRAND, bold: true, fit: 'shrink' });
  slide.addShape(pptx.ShapeType.rect, { x: 0.7, y: 1.3, w: 0.9, h: 0.06, fill: { color: ACCENT }, line: { color: ACCENT } });
  const table = spec.tables[0];
  const bodyHeight = table ? (spec.lines.length ? 2.2 : 0) : 5.4;
  if (spec.lines.length) {
    slide.addText(
      spec.lines.map((line) => ({ text: line.text, options: { bullet: line.bullet ? { indent: 18 } : false, indentLevel: line.level, bold: !line.bullet && spec.lines.length > 1 && line.text.length < 70, breakLine: true, paraSpaceAfter: 8 } })),
      { x: 0.7, y: 1.6, w: 11.9, h: bodyHeight, fontFace: 'Calibri', fontSize: 18, color: INK, valign: 'top', fit: 'shrink' },
    );
  }
  if (table) {
    const head = table.header.map((cell) => ({ text: plain(cell.tokens), options: { bold: true, color: 'FFFFFF', fill: { color: BRAND } } }));
    const rows = table.rows.slice(0, 12).map((row) => row.map((cell) => ({ text: plain(cell.tokens), options: { color: INK } })));
    slide.addTable([head, ...rows], { x: 0.7, y: spec.lines.length ? 3.95 : 1.65, w: 11.9, fontFace: 'Calibri', fontSize: 13, border: { type: 'solid', pt: 0.75, color: 'D9D3C5' }, fill: { color: 'FFFFFF' }, autoPage: false });
  }
  slide.addText(String(number), { x: 12.2, y: 6.95, w: 0.8, h: 0.35, fontFace: 'Calibri', fontSize: 11, color: MUTED, align: 'right' });
}

/** Markdown as a PowerPoint deck: a title slide, then one slide per # / ## heading with bullets and tables. */
export async function markdownPptx(title: string, markdown: string): Promise<Buffer> {
  const tokens = new Lexer({ gfm: true }).lex(markdown);
  const slides = slidesFrom(tokens, title);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  pptx.author = 'Maitre';
  const first = slides[0];
  const opening = first && first.title === title && !first.tables.length && first.lines.length <= 2;
  addTitleSlide(pptx, title, opening ? first.lines.map((line) => line.text).join('\n') : '');
  (opening ? slides.slice(1) : slides).forEach((spec, index) => addContentSlide(pptx, spec, index + 2));
  const data = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(data as Uint8Array);
}
