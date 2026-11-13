import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Attachment, AssistantMessage, Conversation, Settings } from '../src/shared/types';
import { extractDocument, readImage } from '../src/main/documents';
import { IMAGE_TOKENS, buildMessages, contentTokens, userContent, userParts } from '../src/main/agent/context';
import { Runtime } from '../src/main/agent/runtime';
import { toolsFor } from '../src/main/tools';
import { makePdf } from './fixtures/make-pdf.mjs';
import { startMockModel } from './mock-model.mjs';

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maitre-attach-')));
const pdf = makePdf(path.join(dir, 'invoice.pdf'), ['Invoice 1042 for Maitre', 'Total due: 5000 PKR']);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const attachment = (text: string, extra: Partial<Attachment> = {}): Attachment => ({
  id: 'a1', name: 'invoice.pdf', path: pdf, size: 900, kind: 'pdf', pages: 2, chars: text.length, truncated: false, text, ...extra,
});

describe('document extraction', () => {
  it('reads every page of a PDF', async () => {
    const doc = await extractDocument(pdf);
    expect(doc.kind).toBe('pdf');
    expect(doc.pages).toBe(2);
    expect(doc.text).toContain('--- page 1 ---\nInvoice 1042 for Maitre');
    expect(doc.text).toContain('--- page 2 ---\nTotal due: 5000 PKR');
  });

  it('reads text files and refuses images and binaries with a reason', async () => {
    const notes = path.join(dir, 'notes.md');
    fs.writeFileSync(notes, '# Notes\nhello');
    expect((await extractDocument(notes)).text).toBe('# Notes\nhello');
    const image = path.join(dir, 'photo.png');
    fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
    await expect(extractDocument(image)).rejects.toThrow(/attach it to the chat/);
    const blob = path.join(dir, 'data.bin');
    fs.writeFileSync(blob, Buffer.from([1, 0, 2, 0, 3]));
    await expect(extractDocument(blob)).rejects.toThrow(/binary/);
  });

  it('lets the Work agent read a PDF with read_file', async () => {
    const out = await toolsFor('work').get('read_file')!.run({ path: pdf }, { conversationId: 'c', mode: 'work', cwd: dir, signal: new AbortController().signal });
    expect(out).toContain('Total due: 5000 PKR');
  });
});

describe('attachments in the model request', () => {
  it('inlines the extracted text with the file name and path', () => {
    const content = userContent({ id: 'u', role: 'user', content: 'Summarize this', createdAt: 0, attachments: [attachment('Invoice 1042')] }, 'chat');
    expect(content).toContain('Summarize this');
    expect(content).toContain('<attached_file name="invoice.pdf">');
    expect(content).toContain('2 pages');
    expect(content).toContain('Invoice 1042');
  });

  it('cuts very long files and tells the Work agent how to read the rest', () => {
    const long = 'x'.repeat(90_000);
    const content = userContent({ id: 'u', role: 'user', content: 'Read', createdAt: 0, attachments: [attachment(long)] }, 'work');
    expect(content.length).toBeLessThan(62_000);
    expect(content).toContain(`read the rest with read_file on ${pdf}`);
    const built = buildMessages('sys', [{ id: 'u', role: 'user', content: 'Read', createdAt: 0, attachments: [attachment(long)] }], [], 60_000, 1000, undefined, 'work');
    expect(built[1].content).toContain('<attached_file');
  });

  it('sends an attached PDF to the model and names the chat after the file', async () => {
    const model = await startMockModel(() => ({ content: 'The total is 5000 PKR.' }));
    const doc = await extractDocument(pdf);
    const runtime = new Runtime({ settings: () => ({ apiBase: model.url, model: 'maitre-coder', approvalPolicy: 'risky', contextTokens: 60000, maxOutputTokens: 500, memoryEnabled: true }) as Settings, apiKey: () => model.apiKey, save: () => undefined, emit: () => undefined });
    const conversation: Conversation = { id: '00000000-0000-4000-8000-00000000000c', mode: 'chat', title: 'New chat', createdAt: 0, updatedAt: 0, messages: [] };
    await runtime.send(conversation, 'Please look at the attached file(s).', [attachment(doc.text, { chars: doc.text.length })]);
    expect(model.requests[0].messages[1].content).toContain('Total due: 5000 PKR');
    expect(conversation.title).toBe('invoice.pdf');
    expect((conversation.messages[1] as AssistantMessage).content).toBe('The total is 5000 PKR.');
    await model.close();
  });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const image = (name: string, extra: Partial<Attachment> = {}): Attachment => ({
  id: name, name, path: path.join(dir, name), size: PNG.length, kind: 'image', chars: 0, truncated: false, dataUrl: `data:image/png;base64,${PNG.toString('base64')}`, ...extra,
});

describe('images', () => {
  it('reads PNG and JPEG as data URLs and refuses other formats and huge files', () => {
    const png = path.join(dir, 'shot.png');
    fs.writeFileSync(png, PNG);
    expect(readImage(png)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    const jpg = path.join(dir, 'photo.JPG');
    fs.writeFileSync(jpg, PNG);
    expect(readImage(jpg)).toMatch(/^data:image\/jpeg;base64,/);
    const heic = path.join(dir, 'photo.heic');
    fs.writeFileSync(heic, PNG);
    expect(() => readImage(heic)).toThrow(/PNG or JPEG/);
    const big = path.join(dir, 'big.png');
    fs.writeFileSync(big, Buffer.alloc(8_000_001));
    expect(() => readImage(big)).toThrow(/larger than 8 MB/);
  });

  it('sends images as image_url parts next to the text', () => {
    const parts = userParts({ id: 'u', role: 'user', content: 'What is in this?', createdAt: 0, attachments: [image('shot.png'), attachment('Invoice 1042')] }, 'chat', true);
    expect(Array.isArray(parts)).toBe(true);
    const [text, picture] = parts as Exclude<typeof parts, string>;
    expect(text).toMatchObject({ type: 'text' });
    expect(text.type === 'text' && text.text).toContain('Invoice 1042');
    expect(text.type === 'text' && text.text).not.toContain('base64');
    expect(picture).toEqual({ type: 'image_url', image_url: { url: image('shot.png').dataUrl } });
    expect(contentTokens(parts)).toBeLessThan(IMAGE_TOKENS + 100);
  });

  it('keeps images only in the latest three user turns', () => {
    const turns = [1, 2, 3, 4].map((n) => ({ id: `u${n}`, role: 'user' as const, content: `turn ${n}`, createdAt: n, attachments: [image(`pic${n}.png`)] }));
    const built = buildMessages('sys', turns, [], 200_000, 1000);
    expect(built[1].content).toBe('turn 1\n\n[image: pic1.png — no longer shown]');
    for (const message of built.slice(2)) expect(Array.isArray(message.content)).toBe(true);
  });

  it('sends an attached image to the model through the runtime', async () => {
    const model = await startMockModel(() => ({ content: 'A one-pixel picture.' }));
    const runtime = new Runtime({ settings: () => ({ apiBase: model.url, model: 'maitre-coder', approvalPolicy: 'risky', contextTokens: 60000, maxOutputTokens: 500, memoryEnabled: true }) as Settings, apiKey: () => model.apiKey, save: () => undefined, emit: () => undefined });
    const conversation: Conversation = { id: '00000000-0000-4000-8000-00000000000d', mode: 'chat', title: 'New chat', createdAt: 0, updatedAt: 0, messages: [] };
    await runtime.send(conversation, 'Describe it', [image('shot.png')]);
    const sent = model.requests[0].messages[1].content;
    expect(sent).toEqual([expect.objectContaining({ type: 'text' }), { type: 'image_url', image_url: { url: image('shot.png').dataUrl } }, expect.objectContaining({ type: 'text', text: expect.stringContaining('<context>') })]);
    await model.close();
  });
});
