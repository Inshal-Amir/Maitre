export interface Frontmatter {
  fields: Map<string, string>;
  body: string;
}

const KEY_LINE = /^([A-Za-z0-9_-]+):\s*(.*)$/;
const BLOCK = /^[>|][+-]?$/;

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1).split(',').map((item) => unquote(item)).filter(Boolean).join(', ');
  return text.replace(/\s+#.*$/, '');
}

const indented = (line: string): boolean => /^\s/.test(line) || line.trim() === '';

/** Reads the value that starts on line `index`: a scalar, a block (`>` / `|`), a list, or a nested map (skipped). */
function readValue(lines: string[], index: number, inline: string): { value: string; next: number } {
  let next = index + 1;
  const children: string[] = [];
  while (next < lines.length && indented(lines[next])) children.push(lines[next++]);
  while (children.length && !children[children.length - 1].trim()) children.pop();
  const items = children.map((line) => line.trim()).filter(Boolean);
  if (BLOCK.test(inline)) {
    const joined = inline.startsWith('|') ? children.map((line) => line.trim()).join('\n') : items.join(' ');
    return { value: joined.trim(), next };
  }
  if (inline) return { value: unquote([inline, ...items].join(' ')), next };
  if (items.length && items.every((item) => item.startsWith('- '))) return { value: items.map((item) => unquote(item.slice(2))).join(', '), next };
  return { value: '', next };
}

/** Splits a SKILL.md (or command .md) into its YAML frontmatter fields and the Markdown body. Handles the YAML subset skills use. */
export function parseFrontmatter(text: string): Frontmatter {
  const source = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const fields = new Map<string, string>();
  if (!source.startsWith('---\n')) return { fields, body: source.trim() };
  const end = source.indexOf('\n---', 4);
  if (end < 0) return { fields, body: source.trim() };
  const lines = source.slice(4, end).split('\n');
  let index = 0;
  while (index < lines.length) {
    const match = KEY_LINE.exec(lines[index]);
    if (!match) {
      index++;
      continue;
    }
    const { value, next } = readValue(lines, index, match[2].trim());
    fields.set(match[1].toLowerCase(), value);
    index = next;
  }
  const after = source.indexOf('\n', end + 4);
  return { fields, body: after < 0 ? '' : source.slice(after + 1).trim() };
}

const yamlString = (value: string): string => (/^[\w .,()/&+-]*$/.test(value) && !/^[-\s]/.test(value) ? value : JSON.stringify(value));

/** A SKILL.md with `name` and `description` frontmatter, as the Agent Skills format expects. */
export function formatSkillFile(name: string, description: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: ${yamlString(description.replace(/\s+/g, ' ').trim())}\n---\n\n${instructions.trim()}\n`;
}

/** First paragraph of a body, for skills and commands without a description. */
export function firstParagraph(body: string): string {
  const paragraph = body.split(/\n\s*\n/).map((part) => part.replace(/^#+\s*/gm, '').trim()).find(Boolean) ?? '';
  const line = paragraph.replace(/\s+/g, ' ');
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

const FLAG_TRUE = /^(true|yes|on)$/i;
const FLAG_FALSE = /^(false|no|off)$/i;

export function flag(fields: Map<string, string>, key: string, fallback: boolean): boolean {
  const value = fields.get(key);
  if (value === undefined) return fallback;
  if (FLAG_TRUE.test(value)) return true;
  if (FLAG_FALSE.test(value)) return false;
  return fallback;
}
