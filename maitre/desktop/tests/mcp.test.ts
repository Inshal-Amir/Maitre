import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent, AssistantMessage, Conversation, ConnectorStatus, Settings } from '../src/shared/types';
import type { ToolContext } from '../src/main/tools/types';
import type { MockGoogle } from './mock-google.mjs';
import type { MockModel } from './mock-model.mjs';
import { McpManager, customSpec, inProcessTransport, riskOf } from '../src/main/mcp/manager';
import { accessToken, account, signIn, signOut } from '../src/main/google/auth';
import { createGoogleServer } from '../src/main/google/server';
import { Runtime } from '../src/main/agent/runtime';
import { startMockGoogle } from './mock-google.mjs';
import { startMockModel } from './mock-model.mjs';
import { writeSecret } from '../src/main/settings';

let google: MockGoogle;
const context: ToolContext = { conversationId: 'c', mode: 'chat', cwd: process.cwd(), signal: new AbortController().signal };

/** Plays the user in the browser: follows Google's consent redirect back to the app's loopback address. */
async function consent(url: string, code = 'good-code'): Promise<void> {
  const auth = new URL(url);
  const redirect = new URL(auth.searchParams.get('redirect_uri')!);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', auth.searchParams.get('state')!);
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  expect(auth.searchParams.get('access_type')).toBe('offline');
  setTimeout(() => fetch(redirect).catch(() => undefined), 50);
}

beforeAll(async () => {
  google = await startMockGoogle(45871);
});
afterAll(async () => {
  await google.close();
});

describe('MCP risk from tool annotations', () => {
  it('maps hints and names to approval risk', () => {
    const tool = (name: string, annotations = {}) => ({ name, inputSchema: { type: 'object' as const }, annotations });
    expect(riskOf(tool('list_files', { readOnlyHint: true }))).toBe('safe');
    expect(riskOf(tool('create_page'))).toBe('normal');
    expect(riskOf(tool('gmail_send'))).toBe('risky');
    expect(riskOf(tool('remove_user'))).toBe('risky');
    expect(riskOf(tool('update_doc', { destructiveHint: true }))).toBe('risky');
  });
});

describe('custom MCP server over stdio (real SDK server)', () => {
  it('connects, lists prefixed tools, calls them and surfaces tool errors', async () => {
    const events: ConnectorStatus[][] = [];
    const manager = new McpManager((statuses) => events.push(statuses));
    const env = { PATH: process.env.PATH ?? '' };
    await manager.connect(customSpec({ id: 'notes', name: 'My Notes', type: 'stdio', command: process.execPath, args: [path.join(__dirname, 'fixtures/notes-server.mjs')], enabled: true }, env, undefined));
    const [status] = manager.statuses();
    expect(status).toMatchObject({ state: 'connected', name: 'My Notes' });
    expect(status.tools.sort()).toEqual(['my_notes_add_note', 'my_notes_delete_all', 'my_notes_list_notes']);
    const tools = new Map(manager.tools().map((tool) => [tool.name, tool]));
    expect(tools.get('my_notes_list_notes')!.assess({}, context).risk).toBe('safe');
    expect(tools.get('my_notes_delete_all')!.assess({}, context).risk).toBe('risky');
    expect(await tools.get('my_notes_add_note')!.run({ text: 'buy milk' }, context)).toBe('saved note 1');
    expect(await tools.get('my_notes_list_notes')!.run({}, context)).toBe('buy milk');
    await expect(tools.get('my_notes_delete_all')!.run({}, context)).rejects.toThrow('nope');
    expect(events.some((list) => list[0]?.state === 'connecting')).toBe(true);
    await manager.closeAll();
    expect(manager.tools()).toHaveLength(0);
  });

  it('reports a server that fails to start', async () => {
    const manager = new McpManager(() => undefined);
    await manager.connect(customSpec({ id: 'bad', name: 'Bad', type: 'stdio', command: 'definitely-not-a-program-xyz', args: [], enabled: true }, { PATH: '' }, undefined));
    expect(manager.statuses()[0].state).toBe('error');
  });
});

describe('Google sign-in (OAuth PKCE + loopback)', () => {
  it('stores the account, refreshes an expired token and signs out', async () => {
    const email = await signIn(['gmail', 'calendar'], async (url) => consent(url));
    expect(email).toBe('tester@gmail.com');
    expect(account()).toEqual({ email: 'tester@gmail.com', services: ['gmail', 'calendar'] });
    expect(await accessToken()).toBe('at-1');
    const stored = { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() - 1000, email, services: ['gmail', 'calendar'] };
    writeSecret('google', JSON.stringify(stored));
    expect(await accessToken()).toBe('at-2');
    await signOut();
    expect(account()).toBeNull();
    google.tokens.current = 'at-1';
  });

  it('rejects a refused consent', async () => {
    await expect(signIn(['gmail'], async (url) => consent(url, 'bad-code'))).rejects.toThrow(/invalid_grant/);
  });
});

describe('built-in Google MCP server', () => {
  const manager = new McpManager(() => undefined);
  const token = async (): Promise<string> => 'at-1';

  beforeAll(async () => {
    await manager.connect({ id: 'google', name: 'Google', kind: 'google', prefix: 'google', account: 'tester@gmail.com',
      transport: inProcessTransport((transport) => createGoogleServer(['gmail', 'calendar', 'drive', 'docs', 'sheets'], token).connect(transport)) });
  });
  afterAll(() => manager.closeAll());
  const run = (name: string, args: Record<string, string | number | string[][]>): Promise<string> => manager.tools().find((tool) => tool.name === name)!.run(args, context);

  it('exposes 15 tools with approval risk from annotations', () => {
    const tools = manager.tools();
    expect(tools).toHaveLength(15);
    const risk = (name: string): string => tools.find((tool) => tool.name === name)!.assess({}, context).risk;
    expect(risk('google_gmail_search')).toBe('safe');
    expect(risk('google_gmail_create_draft')).toBe('normal');
    expect(risk('google_gmail_send')).toBe('risky');
    expect(risk('google_calendar_delete_event')).toBe('risky');
  });

  it('searches and reads Gmail, and creates a draft with a correct raw message', async () => {
    const found = await run('google_gmail_search', { query: 'is:unread' });
    expect(found).toContain('id m1');
    expect(found).toContain('Project meeting [unread]');
    expect(found).toMatch(/Can we meet Monday\? It's urgent$/);
    expect(await run('google_gmail_read', { message_id: 'm1' })).toContain('Hi, can we meet Monday at 3?');
    expect(await run('google_gmail_create_draft', { to: 'ali@example.com', subject: 'Meeting ✓', body: 'Monday works.' })).toContain('Draft created (id d1)');
    const draft = google.log.find((entry) => entry.route === 'POST /gmail/v1/users/me/drafts')!;
    const raw = Buffer.from(JSON.parse(draft.body).message.raw, 'base64url').toString('utf8');
    expect(raw).toContain('To: ali@example.com');
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from('Meeting ✓').toString('base64')}?=`);
    expect(raw).toMatch(/\r\n\r\nMonday works\.$/);
  });

  it('lists and creates calendar events without sending invitations', async () => {
    expect(await run('google_calendar_list_events', {})).toContain('Standup');
    expect(await run('google_calendar_create_event', { summary: 'Review', start: '2026-10-01T15:00:00+05:00', end: '2026-10-01T16:00:00+05:00' })).toContain('Event created: Review');
    expect(google.log.find((entry) => entry.route === 'POST /calendar/v3/calendars/primary/events')!.query.sendUpdates).toBe('none');
  });

  it('works with Drive, Docs and Sheets', async () => {
    expect(await run('google_drive_search', { query: 'plan' })).toContain('id f1 | Plan');
    expect(await run('google_drive_read_file', { file_id: 'f1' })).toContain('Step 1: build the app');
    expect(await run('google_drive_create_file', { name: 'notes.txt', content: 'hello' })).toContain('Created notes.txt');
    expect(await run('google_docs_create', { title: 'Summary', content: 'Text' })).toContain('docs.google.com/document/d/doc1');
    expect(await run('google_sheets_read', { spreadsheet_id: 's1', range: 'Sheet1!A1:B2' })).toContain('Ali\t9');
    expect(await run('google_sheets_write', { spreadsheet_id: 's1', range: 'Sheet1!A3', values: [['Sara', '8']] })).toContain('Updated 2 cells');
  });

  it('turns Google API errors into tool errors', async () => {
    const bad = new McpManager(() => undefined);
    await bad.connect({ id: 'g2', name: 'Google', kind: 'google', prefix: 'google', transport: inProcessTransport((t) => createGoogleServer(['gmail'], async () => 'wrong').connect(t)) });
    await expect(bad.tools()[0].run({ query: 'x' }, context)).rejects.toThrow(/401: Invalid Credentials/);
    await bad.closeAll();
  });

  it('lets the agent use Gmail in Chat mode and asks before sending', async () => {
    const model: MockModel = await startMockModel((body) => {
      const toolMessages = body.messages.filter((m) => m.role === 'tool');
      if (!toolMessages.length) return { tool_calls: [{ name: 'google_gmail_search', arguments: JSON.stringify({ query: 'is:unread' }) }, { name: 'google_gmail_send', arguments: JSON.stringify({ to: 'ali@example.com', subject: 'Hi', body: 'Yes' }) }] };
      return { content: `Summary: ${(toolMessages[0].content ?? '').split('\n')[1].trim()}` };
    });
    const events: AgentEvent[] = [];
    const settings = { apiBase: model.url, model: 'maitre-coder', approvalPolicy: 'risky', contextTokens: 60000, maxOutputTokens: 1000 } as Settings;
    const runtime = new Runtime({ settings: () => settings, apiKey: () => model.apiKey, save: () => undefined, emit: (event) => {
      events.push(event);
      if (event.type === 'approval') runtime.approvals.decide(event.request.id, 'deny');
    }, extraTools: () => manager.tools(), connectedApps: () => ['Google (tester@gmail.com)'] });
    const conversation: Conversation = { id: '00000000-0000-4000-8000-000000000009', mode: 'chat', title: 'New chat', createdAt: 0, updatedAt: 0, messages: [] };
    await runtime.send(conversation, 'summarize my unread email');
    const steps = conversation.messages.filter((m): m is AssistantMessage => m.role === 'assistant');
    expect(steps[0].toolCalls.map((call) => call.status)).toEqual(['done', 'denied']);
    expect(steps[1].content).toContain('Project meeting');
    expect(model.requests[0].tools?.map((tool) => tool.function.name)).toContain('google_gmail_search');
    expect(model.requests[0].messages[0].content).toContain('Google (tester@gmail.com)');
    expect(google.log.some((entry) => entry.route === 'POST /gmail/v1/users/me/messages/send')).toBe(false);
    await model.close();
  });
});
