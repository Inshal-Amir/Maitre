import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/main/tools/types';
import { createFile } from '../src/main/tools/create';

const REPORT = `# Weekly Email Report

**Period:** 26 Oct – 2 Nov 2026

## Summary

- **33** messages, 32 unread
- Iqbal Day poster due *5 November*

## Volume

| Category | Count |
|---|---|
| Google Classroom | 13 |
| Promotions | 9 |

## Next steps

1. Submit the poster
2. Check the security alert
`;

function workContext(): ToolContext {
  return { conversationId: 'c', mode: 'work', cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'maitre-create-')), signal: new AbortController().signal };
}

const savedPath = (result: string): string => /^Created (.+)$/m.exec(result)![1];

describe('create_file', () => {
  it('writes a Word document with real headings, bold text, lists and a table', async () => {
    const context = workContext();
    const file = savedPath(await createFile.run({ format: 'docx', title: 'Weekly Email Report', content: REPORT }, context));
    expect(file).toBe(path.join(context.cwd, 'Weekly Email Report.docx'));
    const xml = await (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml')!.async('string');
    expect(xml).toContain('w:val="Heading2"');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('Google Classroom');
    expect(xml).toContain('w:numId');
    expect(xml).not.toContain('**');
  });

  it('drops YAML front matter instead of printing it as text', async () => {
    const context = workContext();
    const content = `---\ntitle: "Weekly Email Report"\nauthor: "Office"\n---\n\n${REPORT}`;
    const file = savedPath(await createFile.run({ format: 'docx', title: 'Weekly Email Report', content }, context));
    const xml = await (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml')!.async('string');
    expect(xml).not.toContain('author:');
    expect(xml).toContain('Google Classroom');
  });

  it('writes a PowerPoint deck with a title slide and one slide per heading', async () => {
    const context = workContext();
    const file = savedPath(await createFile.run({ format: 'pptx', title: 'Weekly Email Report', content: REPORT }, context));
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(slides).toHaveLength(4);
    const volume = await zip.file('ppt/slides/slide3.xml')!.async('string');
    expect(volume).toContain('Volume');
    expect(volume).toContain('<a:tbl>');
    expect(volume).toContain('Promotions');
  });

  it('never overwrites an existing file and rejects unknown formats', async () => {
    const context = workContext();
    const first = savedPath(await createFile.run({ format: 'md', title: 'Notes', content: '# A' }, context));
    const second = savedPath(await createFile.run({ format: 'md', title: 'Notes', content: '# B' }, context));
    expect(path.basename(second)).toBe('Notes (2).md');
    expect(fs.readFileSync(first, 'utf8')).toBe('# A');
    await expect(createFile.run({ format: 'exe', title: 'x', content: 'y' }, context)).rejects.toThrow(/Unknown format/);
  });
});
