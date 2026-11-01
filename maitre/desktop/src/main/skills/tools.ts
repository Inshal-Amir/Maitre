import type { ArgValue, Tool, ToolContext } from '../tools/types';
import type { SkillFile } from './index';
import { ToolError, clip, optBool, str } from '../tools/types';
import { applyArguments, findSkill, instructionsOf, readSkillFile, saveUserSkill, skillSlug } from './index';

/** Project skills only exist for Work tasks; Chat runs in the home folder. */
const cwdFor = (context: ToolContext): string | undefined => (context.mode === 'work' ? context.cwd : undefined);

function requireSkill(name: string, context: ToolContext): NonNullable<ReturnType<typeof findSkill>> {
  const skill = findSkill(name, cwdFor(context));
  if (!skill) throw new ToolError(`No enabled skill named "${name}". Use one of the names listed under Skills in your instructions.`);
  return skill;
}

function skillFiles(raw: ArgValue | undefined): SkillFile[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ToolError('"files" must be a list of { path, content } objects.');
  return raw.map((entry) => {
    const file = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new ToolError('Each file needs a "path" and a "content" string.');
    return { path: file.path, content: file.content };
  });
}

export const skillTools: Tool[] = [
  {
    name: 'use_skill',
    description: 'Load a skill\'s full instructions (and the list of files in its folder). Call it before starting work that matches a skill listed in your instructions, then follow what it says.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name exactly as listed, e.g. "code-review" or "document-skills:pdf"' },
        arguments: { type: 'string', description: 'Optional: what the skill should work on, if it takes arguments' },
      },
      required: ['name'],
    },
    modes: ['chat', 'work'],
    assess: (args) => ({ risk: 'safe', title: `Use skill: ${String(args.name ?? '')}`, detail: '', allowKey: 'skill' }),
    async run(args, context) {
      const skill = requireSkill(str(args, 'name'), context);
      const instructions = applyArguments(instructionsOf(skill), typeof args.arguments === 'string' ? args.arguments.trim() : '', skill);
      const files = skill.files.length
        ? `Files in the skill folder: ${skill.files.join(', ')}\n${context.mode === 'work' ? `Read them with read_skill_file, or run scripts from ${skill.dir} with run_command.` : 'Read them with read_skill_file when the instructions refer to them. Scripts can only run in Work mode.'}`
        : '';
      const folder = skill.dir ? `Skill folder: ${skill.dir}` : '';
      return clip([`# Skill: ${skill.name}`, folder, files, '', instructions].filter((line, index) => index >= 3 || line).join('\n'), 40_000);
    },
  },
  {
    name: 'read_skill_file',
    description: 'Read a reference file, template or script that belongs to a skill (paths are relative to the skill folder, as listed by use_skill).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        path: { type: 'string', description: 'File path inside the skill folder, e.g. "reference.md" or "scripts/convert.py"' },
      },
      required: ['name', 'path'],
    },
    modes: ['chat', 'work'],
    assess: (args) => ({ risk: 'safe', title: `Read ${String(args.path ?? '')} from skill ${String(args.name ?? '')}`, detail: '', allowKey: 'skill' }),
    async run(args, context) {
      const skill = requireSkill(str(args, 'name'), context);
      try {
        return clip(readSkillFile(skill, str(args, 'path')), 40_000);
      } catch (error) {
        throw new ToolError((error as Error).message);
      }
    },
  },
  {
    name: 'create_skill',
    description: 'Save a new skill (or replace one of the user\'s skills) in ~/.maitre/skills so it can be used in every future chat. Use the skill-creator skill first for how to write a good one.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'lowercase-hyphen name, e.g. weekly-report' },
        description: { type: 'string', description: 'What it does and when to use it (this decides when the skill is picked)' },
        instructions: { type: 'string', description: 'The Markdown body of SKILL.md: goal, steps, formats, examples' },
        files: {
          type: 'array',
          description: 'Optional extra files: references, templates or scripts, with paths relative to the skill folder',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
        replace: { type: 'boolean', description: 'Set true to overwrite an existing skill of the user with this name' },
      },
      required: ['name', 'description', 'instructions'],
    },
    modes: ['chat', 'work'],
    assess: (args) => {
      const name = skillSlug(String(args.name ?? ''));
      const files = Array.isArray(args.files) ? args.files.length : 0;
      return { risk: 'normal', title: `${optBool(args, 'replace') ? 'Update' : 'Create'} skill: ${name}`, detail: `${String(args.description ?? '')}${files ? `\n+ ${files} file(s)` : ''}`, allowKey: 'create-skill' };
    },
    async run(args, context) {
      const name = skillSlug(str(args, 'name'));
      const existing = findSkill(name, cwdFor(context));
      const replace = optBool(args, 'replace');
      if (existing?.source === 'user' && !replace) throw new ToolError(`The user already has a skill named "${name}". Pass replace: true to update it, or pick another name.`);
      try {
        const saved = saveUserSkill(
          { name, description: str(args, 'description'), instructions: str(args, 'instructions') },
          existing && replace ? existing.id : undefined,
          skillFiles(args.files),
        );
        return `Saved skill "${saved.name}" in ${saved.dir}. The user can run it by typing /${saved.name}, and you will see it in your skills list from now on.`;
      } catch (error) {
        throw new ToolError((error as Error).message);
      }
    },
  },
];
