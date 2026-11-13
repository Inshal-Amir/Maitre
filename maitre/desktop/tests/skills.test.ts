import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, Conversation, Settings } from '../src/shared/types';
import type { ToolContext } from '../src/main/tools/types';
import type { MockModel } from './mock-model.mjs';
import { findSkill, getSkillDocument, importSkillFolders, listSkills, resolveInvocation, saveUserSkill, setSkillEnabled, skillFoldersIn, skillsChanged, skillsPrompt, userSkillsRoot } from '../src/main/skills';
import { parseFrontmatter } from '../src/main/skills/parse';
import { getSettings, saveSettings } from '../src/main/settings';
import { toolInfos, toolsFor } from '../src/main/tools';
import { Runtime } from '../src/main/agent/runtime';
import { claudeHome } from '../src/main/home';
import { startMockModel } from './mock-model.mjs';

const context = (cwd = os.tmpdir(), mode: 'chat' | 'work' = 'chat'): ToolContext => ({ conversationId: 'c', mode, cwd, signal: new AbortController().signal });

function writeSkill(root: string, folder: string, frontmatter: string, body: string, extra: Record<string, string> = {}): string {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
  for (const [file, content] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

beforeEach(() => {
  fs.rmSync(userSkillsRoot(), { recursive: true, force: true });
  fs.rmSync(path.join(claudeHome(), 'skills'), { recursive: true, force: true });
  saveSettings({ disabledSkills: [], disabledTools: [], claudeSkills: true });
  skillsChanged();
});

describe('SKILL.md frontmatter', () => {
  it('reads quoted, folded, literal and list values and keeps the body', () => {
    const { fields, body } = parseFrontmatter([
      '﻿---',
      'name: "pdf-tools"',
      'description: >',
      '  Fills PDF forms',
      '  and merges files.',
      "argument-hint: '[file]'",
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      'metadata:',
      '  author: someone',
      'notes: |',
      '  line one',
      '  line two',
      'disable-model-invocation: true',
      '---',
      '# Title',
      '',
      'Body text.',
    ].join('\r\n'));
    expect(fields.get('name')).toBe('pdf-tools');
    expect(fields.get('description')).toBe('Fills PDF forms and merges files.');
    expect(fields.get('argument-hint')).toBe('[file]');
    expect(fields.get('allowed-tools')).toBe('Read, Bash');
    expect(fields.get('metadata')).toBe('');
    expect(fields.get('notes')).toBe('line one\nline two');
    expect(fields.get('disable-model-invocation')).toBe('true');
    expect(body).toBe('# Title\n\nBody text.');
  });

  it('treats a file without frontmatter as all body', () => {
    expect(parseFrontmatter('Just text')).toEqual({ fields: new Map(), body: 'Just text' });
  });
});

describe('skill registry', () => {
  it('ships built-in skills and lists them for the agent', () => {
    const names = listSkills().map((skill) => skill.name);
    expect(names).toEqual(expect.arrayContaining(['skill-creator', 'code-review', 'debugging', 'research-report', 'professional-writing']));
    expect(skillsPrompt()).toContain('- code-review: Reviews code changes');
  });

  it('saves, edits, overrides, disables and imports user skills', () => {
    const saved = saveUserSkill({ name: 'Weekly Report', description: 'Writes the weekly client report. Use for weekly status updates.', instructions: '# Weekly\nUse a table.' });
    expect(saved).toMatchObject({ id: 'user:weekly-report', name: 'weekly-report', source: 'user', editable: true });
    expect(fs.readFileSync(path.join(userSkillsRoot(), 'weekly-report', 'SKILL.md'), 'utf8')).toBe('---\nname: weekly-report\ndescription: Writes the weekly client report. Use for weekly status updates.\n---\n\n# Weekly\nUse a table.\n');
    expect(() => saveUserSkill({ name: 'weekly-report', description: 'Another one with the same name here.', instructions: 'x' })).toThrow(/already exists/);

    const renamed = saveUserSkill({ name: 'client-report', description: 'Writes the client report: "weekly" or monthly.', instructions: 'New body' }, saved.id);
    expect(fs.existsSync(path.join(userSkillsRoot(), 'weekly-report'))).toBe(false);
    expect(getSkillDocument(renamed.id)).toMatchObject({ description: 'Writes the client report: "weekly" or monthly.', instructions: 'New body' });

    const override = saveUserSkill({ name: 'code-review', description: 'My own review checklist for this team.', instructions: 'Check naming.' }, 'builtin:code-review');
    expect(override.source).toBe('user');
    expect(listSkills().filter((skill) => skill.name === 'code-review')).toHaveLength(1);

    setSkillEnabled(renamed.id, false);
    expect(findSkill('client-report')).toBeNull();
    expect(skillsPrompt()).not.toContain('client-report');
    expect(listSkills().find((skill) => skill.id === renamed.id)?.enabled).toBe(false);
    setSkillEnabled(renamed.id, true);

    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-src-'));
    writeSkill(source, 'one', 'name: one\ndescription: First imported skill for tests.', 'Body one', { 'scripts/run.py': 'print(1)' });
    writeSkill(source, 'two', 'description: Second imported skill without a name field.', 'Body two');
    const imported = importSkillFolders(skillFoldersIn(source));
    expect(imported.map((skill) => skill.name).sort()).toEqual(['one', 'two']);
    expect(imported.find((skill) => skill.name === 'one')?.files).toEqual(['scripts/run.py']);
    expect(() => importSkillFolders(skillFoldersIn(fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'))))).toThrow(/No SKILL.md/);
  });

  it('offers Claude Code skills when allowed and project skills in Work tasks', () => {
    writeSkill(path.join(claudeHome(), 'skills'), 'from-claude', 'name: from-claude\ndescription: A skill made in Claude Code.', 'Claude body');
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'));
    writeSkill(path.join(project, '.maitre', 'skills'), 'deploy', 'name: deploy\ndescription: Deploys this project to staging.\ndisable-model-invocation: true', 'Run ./deploy.sh');
    skillsChanged();
    expect(findSkill('from-claude')?.source).toBe('claude');
    expect(findSkill('deploy')).toBeNull();
    expect(findSkill('deploy', project)).toMatchObject({ source: 'project', modelInvocable: false });
    expect(skillsPrompt(project)).not.toContain('deploy');
    saveSettings({ claudeSkills: false });
    skillsChanged();
    expect(findSkill('from-claude')).toBeNull();
  });

  it('resolves /name invocations with arguments and folder variables', () => {
    const dir = writeSkill(userSkillsRoot(), 'greet', 'name: greet\ndescription: Greets someone by name in a language.\nargument-hint: <name> <language>', 'Say hi to $1 in $2. All: $ARGUMENTS. Files: ${CLAUDE_SKILL_DIR}/data');
    writeSkill(userSkillsRoot(), 'plain', 'name: plain\ndescription: A skill without argument placeholders.', 'Do the plain thing.');
    skillsChanged();
    expect(resolveInvocation('/greet "Ali Khan" urdu')).toEqual({ name: 'greet', arguments: '"Ali Khan" urdu', instructions: `Say hi to Ali Khan in urdu. All: "Ali Khan" urdu. Files: ${dir}/data`, dir });
    expect(resolveInvocation('/plain extra words')?.instructions).toBe('Do the plain thing.\n\nARGUMENTS: extra words');
    expect(resolveInvocation('/unknown thing')).toBeNull();
    expect(resolveInvocation('not a command')).toBeNull();
  });
});

describe('skill tools', () => {
  it('loads a skill, reads its files safely and creates new skills', async () => {
    writeSkill(userSkillsRoot(), 'invoice', 'name: invoice\ndescription: Makes invoices from timesheets.', 'Use template.md', { 'template.md': '# Invoice {{n}}', 'bin.dat': '\u0000\u0001' });
    skillsChanged();
    const tools = toolsFor('chat');
    const loaded = await tools.get('use_skill')!.run({ name: 'invoice' }, context());
    expect(loaded).toContain('# Skill: invoice');
    expect(loaded).toContain('Files in the skill folder: bin.dat, template.md');
    expect(loaded).toContain('Use template.md');
    expect(await tools.get('read_skill_file')!.run({ name: 'invoice', path: 'template.md' }, context())).toBe('# Invoice {{n}}');
    await expect(tools.get('read_skill_file')!.run({ name: 'invoice', path: '../../secret' }, context())).rejects.toThrow(/inside the skill folder|outside/);
    await expect(tools.get('read_skill_file')!.run({ name: 'invoice', path: 'bin.dat' }, context())).rejects.toThrow(/binary/);
    await expect(tools.get('use_skill')!.run({ name: 'nope' }, context())).rejects.toThrow(/No enabled skill/);

    const create = tools.get('create_skill')!;
    expect(create.assess({ name: 'Standup Notes', description: 'x' }, context()).risk).toBe('normal');
    const result = await create.run({ name: 'standup-notes', description: 'Turns rough notes into a standup update.', instructions: 'Yesterday / Today / Blockers', files: [{ path: 'example.md', content: 'Example' }] }, context());
    expect(result).toContain('/standup-notes');
    expect(fs.readFileSync(path.join(userSkillsRoot(), 'standup-notes', 'example.md'), 'utf8')).toBe('Example');
    await expect(create.run({ name: 'standup-notes', description: 'Turns rough notes into a standup update.', instructions: 'v2' }, context())).rejects.toThrow(/replace: true/);
    await create.run({ name: 'standup-notes', description: 'Turns rough notes into a standup update.', instructions: 'v2', replace: true }, context());
    expect(getSkillDocument('user:standup-notes')?.instructions).toBe('v2');
    await expect(create.run({ name: 'x', description: 'too short', instructions: 'y', files: [{ path: '../escape.txt', content: 'no' }] }, context())).rejects.toThrow();
  });

  it('lets the user switch built-in tools off, except the locked ones', () => {
    const disabled = ['web_search', 'use_skill'];
    expect(toolsFor('chat', disabled).has('web_search')).toBe(false);
    expect(toolsFor('chat', disabled).has('use_skill')).toBe(true);
    const infos = toolInfos(disabled);
    expect(infos.find((tool) => tool.name === 'web_search')).toMatchObject({ enabled: false, locked: false, group: 'Web and GitHub' });
    expect(infos.find((tool) => tool.name === 'use_skill')).toMatchObject({ enabled: true, locked: true, group: 'Skills' });
  });
});

describe('skills in the agent loop', () => {
  let model: MockModel;
  afterEach(async () => model?.close());

  it('lists skills in the system prompt, runs /skill invocations and use_skill calls', async () => {
    writeSkill(userSkillsRoot(), 'haiku', 'name: haiku\ndescription: Writes a haiku about a topic.', 'Write 5-7-5 syllables about $ARGUMENTS.');
    skillsChanged();
    model = await startMockModel((_body, count) => {
      if (count === 1) return { content: 'A haiku.' };
      if (count === 2) return { tool_calls: [{ name: 'use_skill', arguments: JSON.stringify({ name: 'code-review' }) }] };
      return { content: 'Reviewed.' };
    });
    const settings: Settings = { ...getSettings(), apiBase: model.url, approvalPolicy: 'risky', disabledTools: ['web_search'] };
    const runtime = new Runtime({ settings: () => settings, apiKey: () => model.apiKey, save: () => undefined, emit: () => undefined });
    const conversation: Conversation = { id: '00000000-0000-4000-8000-0000000000aa', mode: 'chat', title: 'New chat', createdAt: 0, updatedAt: 0, messages: [] };

    await runtime.send(conversation, '/haiku autumn rain');
    const first = model.requests[0];
    expect(first.messages[0].content).toContain('- haiku: Writes a haiku about a topic.');
    expect(first.messages[1].content).toContain('<skill name="haiku">');
    expect(first.messages[1].content).toContain('Write 5-7-5 syllables about autumn rain.');
    expect(first.messages[1].content).toMatch(/<\/skill>\n\n\/haiku autumn rain\n\n<context>/);
    expect(first.tools?.map((tool) => tool.function.name)).not.toContain('web_search');
    expect(conversation.messages[0]).toMatchObject({ role: 'user', content: '/haiku autumn rain', skill: { name: 'haiku', arguments: 'autumn rain' } });

    await runtime.send(conversation, 'please review my code');
    const step = conversation.messages.filter((m): m is AssistantMessage => m.role === 'assistant')[1];
    expect(step.toolCalls[0]).toMatchObject({ name: 'use_skill', status: 'done', risk: 'safe' });
    expect(step.toolCalls[0].result).toContain('# Code review');
  });
});
