import { Lexer } from 'marked';
import type { Token, Tokens } from 'marked';
import type { ParagraphChild } from 'docx';
import { AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, LevelFormat, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';

const BRAND = '1F4A3D';
const LINE = 'D9D3C5';
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  code?: boolean;
  strike?: boolean;
}

type Block = Paragraph | Table;

const decode = (text: string): string => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const run = (text: string, style: RunStyle): TextRun =>
  new TextRun({ text: decode(text), bold: style.bold, italics: style.italics, strike: style.strike, ...(style.code ? { font: 'Consolas', size: 19, shading: { type: ShadingType.CLEAR, fill: 'F1EDE3', color: 'auto' } } : {}) });

function inline(tokens: Token[] = [], style: RunStyle = {}): ParagraphChild[] {
  return tokens.flatMap((token): ParagraphChild[] => {
    if (token.type === 'strong') return inline((token as Tokens.Strong).tokens, { ...style, bold: true });
    if (token.type === 'em') return inline((token as Tokens.Em).tokens, { ...style, italics: true });
    if (token.type === 'del') return inline((token as Tokens.Del).tokens, { ...style, strike: true });
    if (token.type === 'codespan') return [run((token as Tokens.Codespan).text, { ...style, code: true })];
    if (token.type === 'br') return [new TextRun({ text: '', break: 1 })];
    if (token.type === 'link') {
      const link = token as Tokens.Link;
      return [new ExternalHyperlink({ link: link.href, children: [new TextRun({ text: decode(link.text), style: 'Hyperlink', bold: style.bold })] })];
    }
    if ('tokens' in token && Array.isArray(token.tokens) && token.tokens.length) return inline(token.tokens, style);
    return [run('text' in token && typeof token.text === 'string' ? token.text : token.raw, style)];
  });
}

function listItems(list: Tokens.List, level: number): Paragraph[] {
  return list.items.flatMap((item) => {
    const lead = item.tokens.filter((token) => token.type !== 'list');
    const children = lead.flatMap((token) => inline('tokens' in token && Array.isArray(token.tokens) ? token.tokens : [token]));
    const own = new Paragraph({ children, numbering: { reference: list.ordered ? 'numbered' : 'bullets', level: Math.min(level, 5) } });
    const nested = item.tokens.filter((token): token is Tokens.List => token.type === 'list').flatMap((child) => listItems(child, level + 1));
    return [own, ...nested];
  });
}

const cellBorders = { top: { style: BorderStyle.SINGLE, size: 4, color: LINE }, bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE }, left: { style: BorderStyle.SINGLE, size: 4, color: LINE }, right: { style: BorderStyle.SINGLE, size: 4, color: LINE } };

function table(token: Tokens.Table): Table {
  const cell = (content: Tokens.TableCell, header: boolean): TableCell =>
    new TableCell({
      borders: cellBorders,
      shading: header ? { type: ShadingType.CLEAR, fill: 'F1EDE3', color: 'auto' } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: inline(content.tokens, { bold: header }) })],
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: token.header.map((content) => cell(content, true)) }), ...token.rows.map((row) => new TableRow({ children: row.map((content) => cell(content, false)) }))],
  });
}

function blocks(tokens: Token[]): Block[] {
  return tokens.flatMap((token): Block[] => {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        return [new Paragraph({ heading: HEADINGS[heading.depth - 1], children: inline(heading.tokens) })];
      }
      case 'paragraph':
        return [new Paragraph({ children: inline((token as Tokens.Paragraph).tokens) })];
      case 'list':
        return listItems(token as Tokens.List, 0);
      case 'table':
        return [table(token as Tokens.Table), new Paragraph({ children: [] })];
      case 'code':
        return (token as Tokens.Code).text.split('\n').map((line) => new Paragraph({ shading: { type: ShadingType.CLEAR, fill: 'F6F3EC', color: 'auto' }, spacing: { after: 0 }, children: [run(line || ' ', { code: true })] }));
      case 'blockquote':
        return blocks((token as Tokens.Blockquote).tokens);
      case 'hr':
        return [new Paragraph({ thematicBreak: true, children: [] })];
      case 'space':
        return [];
      default:
        return token.raw.trim() ? [new Paragraph({ children: [run(token.raw.trim(), {})] })] : [];
    }
  });
}

const levels = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: (level: number) => string) =>
  Array.from({ length: 6 }, (_, level) => ({ level, format, text: text(level), alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } } }));

/** Markdown as a Word document: headings, lists, tables, code and links become real Word formatting. */
export async function markdownDocx(title: string, markdown: string): Promise<Buffer> {
  const tokens = new Lexer({ gfm: true }).lex(markdown);
  const startsWithTitle = tokens.find((token) => token.type !== 'space')?.type === 'heading';
  const titleBlock = startsWithTitle ? [] : [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] })];
  const document = new Document({
    creator: 'Maitre',
    title,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { after: 120, line: 288 } } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', run: { size: 44, bold: true, color: BRAND }, paragraph: { spacing: { after: 240 } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', run: { size: 32, bold: true, color: BRAND }, paragraph: { spacing: { before: 320, after: 120 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', run: { size: 26, bold: true, color: BRAND }, paragraph: { spacing: { before: 280, after: 100 } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', run: { size: 23, bold: true }, paragraph: { spacing: { before: 200, after: 80 } } },
      ],
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: levels(LevelFormat.BULLET, (level) => ['•', '◦', '▪'][level % 3]) },
        { reference: 'numbered', levels: levels(LevelFormat.DECIMAL, (level) => `%${level + 1}.`) },
      ],
    },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children: [...titleBlock, ...blocks(tokens)] }],
  });
  return Packer.toBuffer(document);
}
