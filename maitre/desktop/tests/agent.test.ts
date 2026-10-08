import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent, AssistantMessage, Conversation, Settings } from '../src/shared/types';
import type { MockReply, MockRequest } from './mock-model.mjs';
import { Runtime } from '../src/main/agent/runtime';
import { startMockModel } from './mock-model.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maitre-agent-')));
const project = path.join(root, 'portfolio-site');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const call = (name: string, args: object): MockReply => ({ tool_calls: [{ name, arguments: JSON.stringify(args) }] });

describe('Work agent: understand, workspace, plan, memory', () => {
  it('asks first, sets the project folder, keeps brief and plan in files and shows them on every step', async () => {
    const script: MockReply[] = [
      call('ask_user', { title: 'A few details about your website', questions: [
        { question: 'What is the website for?', options: ['Portfolio', 'Business', 'Blog'] },
        { question: 'Where should I create it?', options: [project, 'Somewhere else'] },
      ] }),
      call('set_project', { path: project, name: 'Portfolio site' }),
      call('update_brief', { markdown: '# Portfolio site\n- Purpose: personal portfolio\n- Stack: Vite + React' }),
      call('update_plan', { goal: 'A running portfolio site', steps: [{ title: 'Scaffold with Vite', status: 'in_progress' }, { title: 'Build pages', status: 'pending' }, { title: 'Verify in browser', status: 'pending' }] }),
      call('add_note', { note: 'Chose Vite because the user wants a static site' }),
      { content: 'Plan is ready.' },
    ];
    const model = await startMockModel((_body, count) => script[Math.min(count, script.length) - 1]);
    const events: AgentEvent[] = [];
    const settings = { apiBase: model.url, model: 'maitre-coder', approvalPolicy: 'never', contextTokens: 60000, maxOutputTokens: 1000, memoryEnabled: false, defaultWorkDir: root } as Settings;
    let runtime: Runtime | null = null;
    runtime = new Runtime({ settings: () => settings, apiKey: () => model.apiKey, save: () => undefined, emit: (event) => {
      events.push(event);
      if (event.type === 'question') runtime!.questions.answer(event.request.id, ['Portfolio', project]);
    } });
    const conversation: Conversation = { id: '00000000-0000-4000-8000-00000000000d', mode: 'work', title: 'New chat', cwd: root, createdAt: 0, updatedAt: 0, messages: [] };
    await runtime.send(conversation, 'Mere liye ek website banao');

    const steps = conversation.messages.filter((m): m is AssistantMessage => m.role === 'assistant');
    expect(steps.map((step) => step.toolCalls[0]?.status ?? 'text')).toEqual(['done', 'done', 'done', 'done', 'done', 'text']);
    expect(steps[0].toolCalls[0].result).toContain('A: Portfolio');
    expect(events.some((event) => event.type === 'question' && event.request.questions[0].options?.includes('Blog'))).toBe(true);

    expect(conversation.cwd).toBe(project);
    expect(fs.readFileSync(path.join(project, '.maitre/brief.md'), 'utf8')).toContain('Purpose: personal portfolio');
    expect(fs.readFileSync(path.join(project, '.maitre/plan.md'), 'utf8')).toMatch(/1\. \[~\] Scaffold with Vite/);
    expect(fs.readFileSync(path.join(project, '.maitre/notes.md'), 'utf8')).toContain('Chose Vite');
    expect(conversation.plan?.steps).toHaveLength(3);
    expect(events.some((event) => event.type === 'conversation' && event.summary.plan?.goal === 'A running portfolio site')).toBe(true);

    const last: MockRequest = model.requests[model.requests.length - 1];
    const system = last.messages[0].content ?? '';
    expect(system).toContain('<brief>');
    expect(system).toContain('Purpose: personal portfolio');
    expect(system).toContain('[~] Scaffold with Vite');
    expect(system).toContain('Chose Vite');
    expect(system).toContain(`Working folder: ${project}`);
    expect(model.requests[0].messages[0].content).toContain(`inside ${root}`);
    expect(model.requests[0].tools?.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(['ask_user', 'set_project', 'update_plan', 'update_brief', 'add_note', 'github_read_file']));
    await model.close();
  });

  it('tells the agent to work in a folder the user picked instead of asking', async () => {
    const picked = fs.mkdtempSync(path.join(root, 'picked-'));
    const model = await startMockModel(() => ({ content: 'ok' }));
    const settings = { apiBase: model.url, model: 'maitre-coder', approvalPolicy: 'never', contextTokens: 60000, maxOutputTokens: 1000, memoryEnabled: false, defaultWorkDir: root } as Settings;
    const runtime = new Runtime({ settings: () => settings, apiKey: () => model.apiKey, save: () => undefined, emit: () => undefined });
    const conversation: Conversation = { id: '00000000-0000-4000-8000-00000000000f', mode: 'work', title: 'New chat', cwd: picked, cwdChosen: true, createdAt: 0, updatedAt: 0, messages: [] };
    await runtime.send(conversation, 'build a website');
    const system = model.requests[0].messages[0].content ?? '';
    expect(system).toContain(`The user chose the working folder for this task: ${picked}`);
    expect(system).toContain(`Working folder: ${picked}`);
    await model.close();
  });

  it('stops cleanly while waiting for an answer', async () => {
    const model = await startMockModel(() => call('ask_user', { questions: [{ question: 'Which stack?', options: ['React', 'Vue'] }] }));
    const settings = { apiBase: model.url, model: 'maitre-coder', approvalPolicy: 'never', contextTokens: 60000, maxOutputTokens: 1000, memoryEnabled: false, defaultWorkDir: root } as Settings;
    const runtime = new Runtime({ settings: () => settings, apiKey: () => model.apiKey, save: () => undefined, emit: (event) => {
      if (event.type === 'question') setTimeout(() => runtime.stop(conversation.id), 50);
    } });
    const conversation: Conversation = { id: '00000000-0000-4000-8000-00000000000e', mode: 'work', title: 'New chat', cwd: root, createdAt: 0, updatedAt: 0, messages: [] };
    await runtime.send(conversation, 'build something');
    const first = conversation.messages.find((m): m is AssistantMessage => m.role === 'assistant')!;
    expect(first.toolCalls[0].status).toBe('cancelled');
    expect(model.requests).toHaveLength(1);
    await model.close();
  });
});
