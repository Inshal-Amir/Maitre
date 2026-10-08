import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AssistantMessage, Conversation, Settings } from '../src/shared/types';
import type { MockModel } from './mock-model.mjs';
import { addMemory, clearMemories, listMemories, memoryPrompt, memoryTools } from '../src/main/memory';
import { Runtime } from '../src/main/agent/runtime';
import { buildMessages } from '../src/main/agent/context';
import { startMockModel } from './mock-model.mjs';

const context = { conversationId: 'c', mode: 'chat' as const, cwd: process.cwd(), signal: new AbortController().signal };
const remember = memoryTools.find((tool) => tool.name === 'remember')!;
let model: MockModel | null = null;

afterEach(async () => {
  clearMemories();
  await model?.close();
  model = null;
});

function settingsFor(url: string, contextTokens = 60_000): Settings {
  return { apiBase: url, model: 'maitre-coder', approvalPolicy: 'risky', contextTokens, maxOutputTokens: 500, memoryEnabled: true } as Settings;
}

describe('memory', () => {
  it('saves facts once, refuses secrets and lists them in the prompt', async () => {
    expect(await remember.run({ fact: 'Prefers answers in Roman Urdu' }, context)).toMatch(/Saved to memory/);
    await remember.run({ fact: 'prefers   answers in roman urdu' }, context);
    expect(listMemories()).toHaveLength(1);
    await expect(remember.run({ fact: 'My OpenAI key is sk-abcdefghijklmnop1234' }, context)).rejects.toThrow(/secret/);
    expect(memoryPrompt()).toContain(`${listMemories()[0].id}: Prefers answers in Roman Urdu`);
  });

  it('reaches the model in every new chat and can be forgotten by the agent', async () => {
    const memory = addMemory('Name is Inshal');
    model = await startMockModel((body) =>
      body.messages.some((m) => m.role === 'tool') ? { content: 'ok' } : { tool_calls: [{ name: 'forget_memory', arguments: JSON.stringify({ id: memory.id }) }] });
    const url = model.url;
    const key = model.apiKey;
    const runtime = new Runtime({ settings: () => settingsFor(url), apiKey: () => key, save: () => undefined, emit: () => undefined });
    const conversation: Conversation = { id: '00000000-0000-4000-8000-00000000000a', mode: 'chat', title: 'New chat', createdAt: 0, updatedAt: 0, messages: [] };
    await runtime.send(conversation, 'forget my name');
    expect(model.requests[0].messages[0].content).toContain('Name is Inshal');
    expect(listMemories()).toHaveLength(0);
  });
});

describe('long chats', () => {
  it('summarizes older turns once the history nears the context window, then sends summary + recent turns', async () => {
    const events: AgentEvent[] = [];
    model = await startMockModel((body) => {
      if (/You compress conversations/.test(body.messages[0].content ?? '')) return { content: '- User is building a todo app in React\n- Decided: Vite + TypeScript' };
      return { content: 'x'.repeat(4000) };
    });
    const url = model.url;
    const key = model.apiKey;
    const runtime = new Runtime({ settings: () => settingsFor(url, 16_000), apiKey: () => key, save: () => undefined, emit: (event) => events.push(event) });
    const conversation: Conversation = { id: '00000000-0000-4000-8000-00000000000b', mode: 'chat', title: 'New chat', createdAt: 0, updatedAt: 0, messages: [] };
    for (let turn = 0; turn < 8; turn++) await runtime.send(conversation, `question ${turn}: ${'y'.repeat(3000)}`);

    expect(conversation.summary?.text).toContain('todo app');
    const upTo = conversation.summary!.upTo;
    expect(conversation.messages[upTo].role).toBe('user');
    const last = model.requests[model.requests.length - 1];
    expect(last.messages[1].content).toContain('[Summary of the earlier part of this conversation');
    expect(last.messages.some((m) => (m.content ?? '').startsWith('question 0'))).toBe(false);
    expect(last.messages.some((m) => (m.content ?? '').startsWith('question 7'))).toBe(true);
    expect(events.some((event) => event.type === 'waiting' && event.phase === 'compacting')).toBe(true);
    expect(events.some((event) => event.type === 'conversation' && event.summary.compactedAt === upTo)).toBe(true);
    const replies = conversation.messages.filter((m): m is AssistantMessage => m.role === 'assistant');
    expect(replies.every((reply) => !reply.error)).toBe(true);
  });

  it('builds a request from the summary and the remaining messages only', () => {
    const messages = [
      { id: '1', role: 'user' as const, content: 'old', createdAt: 0 },
      { id: '2', role: 'user' as const, content: 'new', createdAt: 0 },
    ];
    const built = buildMessages('sys', messages, [], 60_000, 1000, { text: 'the gist', upTo: 1 });
    expect(built.map((m) => m.content)).toEqual(['sys', '[Summary of the earlier part of this conversation, written to save space]\nthe gist', 'new']);
  });
});
