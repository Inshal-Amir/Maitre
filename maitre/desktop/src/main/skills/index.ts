import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import type { InvokedSkill, SkillDocument, SkillDraft, SkillInfo, SkillSource } from '../../shared/types';
import { firstParagraph, flag, formatSkillFile, parseFrontmatter } from './parse';
import { enabledPlugins, pluginDir } from '../plugins/store';
import { getSettings, saveSettings } from '../settings';
import { claudeHome, maitreHome } from '../home';
import { BUILTIN_SKILLS } from './builtin';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_FILES = ['SKILL.md', 'skill.md'];
const MAX_FILES = 60;
const MAX_DEPTH = 3;
const MAX_LISTED = 80;
const MAX_DESCRIPTION = 1024;
const PROMPT_DESCRIPTION = 300;
const CACHE_MS = 2000;
const SKIPPED_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv']);

interface Skill extends SkillInfo {
  /** SKILL.md or the command file; built-in skills carry their text instead. */
  file?: string;
  text?: string;
  /** Plugin folder, for `${CLAUDE_PLUGIN_ROOT}`. */
  pluginRoot?: string;
}

export const userSkillsRoot = (): string => path.join(maitreHome(), 'skills');
const claudeSkillsRoot = (): string => path.join(claudeHome(), 'skills');

/** Lowercase-hyphen form of a skill or command name. */
export const skillSlug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

let listener: () => void = () => undefined;
let cache: { key: string; at: number; skills: Skill[] } | null = null;

export function watchSkills(onChange: () => void): void {
  listener = onChange;
}

/** Forgets the scanned skills (after installs, edits or plugin changes) and tells the UI. */
export function skillsChanged(): void {
  cache = null;
  listener();
}

function listFiles(dir: string, prefix = '', depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (files.length >= MAX_FILES) break;
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), relative, depth + 1));
    else if (!(depth === 0 && SKILL_FILES.includes(entry.name))) files.push(relative);
  }
  return files.slice(0, MAX_FILES);
}

function skillFileIn(dir: string): string | null {
  return SKILL_FILES.map((name) => path.join(dir, name)).find((file) => fs.existsSync(file)) ?? null;
}

interface Origin {
  source: SkillSource;
  editable: boolean;
  plugin?: string;
  pluginRoot?: string;
}

function readSkill(dir: string, origin: Origin): Skill | null {
  const file = skillFileIn(dir);
  if (!file) return null;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { fields, body } = parseFrontmatter(text);
  const base = skillSlug(fields.get('name') || path.basename(dir));
  if (!base) return null;
  const name = origin.plugin ? `${origin.plugin}:${base}` : base;
  return {
    id: origin.plugin ? `plugin:${origin.plugin}:${base}` : `${origin.source}:${base}`,
    name,
    description: (fields.get('description') || firstParagraph(body)).slice(0, MAX_DESCRIPTION),
    source: origin.source,
    kind: 'skill',
    plugin: origin.plugin,
    dir,
    enabled: true,
    modelInvocable: !flag(fields, 'disable-model-invocation', false),
    userInvocable: flag(fields, 'user-invocable', true),
    argumentHint: fields.get('argument-hint') || undefined,
    files: listFiles(dir),
    editable: origin.editable,
    file,
    pluginRoot: origin.pluginRoot,
  };
}

/** A Claude Code style command: one Markdown file whose body is the prompt, run by the user with `/name`. */
function readCommand(file: string, origin: Origin): Skill | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { fields, body } = parseFrontmatter(text);
  const base = skillSlug(path.basename(file, '.md'));
  if (!base || !body) return null;
  return {
    id: `command:${origin.plugin ?? origin.source}:${base}`,
    name: origin.plugin ? `${origin.plugin}:${base}` : base,
    description: (fields.get('description') || firstParagraph(body)).slice(0, MAX_DESCRIPTION),
    source: origin.source,
    kind: 'command',
    plugin: origin.plugin,
    dir: path.dirname(file),
    enabled: true,
    modelInvocable: false,
    userInvocable: true,
    argumentHint: fields.get('argument-hint') || undefined,
    files: [],
    editable: false,
    file,
    pluginRoot: origin.pluginRoot,
  };
}

function subdirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

const scanSkills = (root: string, origin: Origin): Skill[] => subdirs(root).map((dir) => readSkill(dir, origin)).filter((skill): skill is Skill => skill !== null);

const builtins = (): Skill[] => BUILTIN_SKILLS.map((skill) => ({
  id: `builtin:${skill.name}`, name: skill.name, description: skill.description, source: 'builtin', kind: 'skill',
  enabled: true, modelInvocable: true, userInvocable: true, files: [], editable: false, text: skill.instructions,
}));

/** Project skill folders of a Work task, unless the folder is the home folder (whose skills are the user's own). */
function projectRoots(cwd: string | undefined): string[] {
  if (!cwd) return [];
  const roots = [path.join(cwd, '.maitre', 'skills'), path.join(cwd, '.claude', 'skills')];
  return roots.filter((root) => root !== userSkillsRoot() && root !== claudeSkillsRoot());
}

function scan(cwd: string | undefined, withClaude: boolean): Skill[] {
  const ranked: Skill[] = [
    ...projectRoots(cwd).flatMap((root) => scanSkills(root, { source: 'project', editable: false })),
    ...scanSkills(userSkillsRoot(), { source: 'user', editable: true }),
    ...(withClaude ? scanSkills(claudeSkillsRoot(), { source: 'claude', editable: false }) : []),
    ...builtins(),
  ];
  const seen = new Set<string>();
  const own = ranked.filter((skill) => {
    if (seen.has(skill.name)) return false;
    seen.add(skill.name);
    return true;
  });
  const fromPlugins = enabledPlugins().flatMap((plugin) => {
    const root = pluginDir(plugin.id);
    const origin: Origin = { source: 'plugin', editable: false, plugin: plugin.id, pluginRoot: root };
    const pluginSkills = plugin.skillDirs.map((rel) => readSkill(path.join(root, rel), origin));
    const commands = plugin.commandFiles.map((rel) => readCommand(path.join(root, rel), origin));
    return [...pluginSkills, ...commands].filter((skill): skill is Skill => skill !== null);
  });
  return [...own, ...fromPlugins];
}

function skills(cwd?: string): Skill[] {
  const settings = getSettings();
  const key = `${cwd ?? ''}|${settings.claudeSkills}`;
  if (!cache || cache.key !== key || Date.now() - cache.at > CACHE_MS) cache = { key, at: Date.now(), skills: scan(cwd, settings.claudeSkills) };
  const disabled = new Set(settings.disabledSkills);
  return cache.skills.map((skill) => ({ ...skill, enabled: !disabled.has(skill.id) }));
}

const visible = ({ file: _file, text: _text, pluginRoot: _root, ...info }: Skill): SkillInfo => info;

export const listSkills = (cwd?: string): SkillInfo[] => skills(cwd).map(visible);

/** An enabled skill by name: exact, or a plugin skill by its short name when only one plugin has it. */
export function findSkill(name: string, cwd?: string): Skill | null {
  const wanted = name.trim().replace(/^\//, '').toLowerCase();
  const enabled = skills(cwd).filter((skill) => skill.enabled);
  const exact = enabled.find((skill) => skill.name === wanted);
  if (exact) return exact;
  const short = enabled.filter((skill) => skill.name.endsWith(`:${wanted}`));
  return short.length === 1 ? short[0] : null;
}

export function instructionsOf(skill: Skill): string {
  if (skill.text !== undefined) return skill.text;
  if (!skill.file) return '';
  try {
    return parseFrontmatter(fs.readFileSync(skill.file, 'utf8')).body;
  } catch {
    return '';
  }
}

function splitArguments(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

/** Fills `$ARGUMENTS`, `$1`…, `$ARGUMENTS[n]` and the folder variables the Claude Code formats use. */
export function applyArguments(instructions: string, args: string, skill: Pick<Skill, 'dir' | 'pluginRoot'>): string {
  const parts = splitArguments(args);
  const dir = skill.dir ?? '';
  let text = instructions
    .replace(/\$\{(CLAUDE_SKILL_DIR|MAITRE_SKILL_DIR)\}/g, dir)
    .replace(/\$\{(CLAUDE_PLUGIN_ROOT|MAITRE_PLUGIN_ROOT)\}/g, skill.pluginRoot ?? dir);
  const usesArguments = /\$ARGUMENTS|\$\d/.test(text);
  text = text
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index: string) => parts[Number(index)] ?? '')
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\$(\d)/g, (_match, index: string) => parts[Number(index) - 1] ?? '');
  return !usesArguments && args ? `${text}\n\nARGUMENTS: ${args}` : text;
}

/** `/name rest of message` → the skill or command the user called, with its instructions filled in. */
export function resolveInvocation(text: string, cwd?: string): InvokedSkill | null {
  const match = /^\/([a-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const skill = findSkill(match[1], cwd);
  if (!skill || !skill.userInvocable) return null;
  const args = (match[2] ?? '').trim();
  return { name: skill.name, arguments: args, instructions: applyArguments(instructionsOf(skill), args, skill), dir: skill.dir };
}

/** The skills block of the system prompt: names and descriptions only; use_skill loads the rest. */
export function skillsPrompt(cwd?: string): string {
  const offered = skills(cwd).filter((skill) => skill.enabled && skill.modelInvocable).slice(0, MAX_LISTED);
  if (!offered.length) return '';
  const lines = offered.map((skill) => {
    const description = skill.description.replace(/\s+/g, ' ');
    return `- ${skill.name}: ${description.length > PROMPT_DESCRIPTION ? `${description.slice(0, PROMPT_DESCRIPTION - 1)}…` : description}`;
  });
  return `Skills: packaged instructions for specific kinds of work, written by the user, plugins or Maitre. When a request matches a skill's description, call use_skill with its name BEFORE doing the work and follow its instructions (they can point to scripts or reference files in the skill's folder). Use at most the skills that fit; do not mention skills that are not relevant.\n${lines.join('\n')}`;
}

export function getSkillDocument(id: string, cwd?: string): SkillDocument | null {
  const skill = skills(cwd).find((entry) => entry.id === id);
  return skill ? { ...visible(skill), instructions: instructionsOf(skill) } : null;
}

export interface SkillFile {
  path: string;
  content: string;
}

function safeRelative(file: string): string {
  const normalized = path.normalize(file).replace(/^([/\\])+/, '');
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) throw new Error(`"${file}" must be a path inside the skill folder.`);
  return normalized;
}

function validDraft(draft: SkillDraft): SkillDraft {
  const name = skillSlug(draft.name);
  const description = draft.description.replace(/\s+/g, ' ').trim();
  if (!SKILL_NAME.test(name)) throw new Error('Give the skill a name: lowercase letters, digits and hyphens (e.g. weekly-report).');
  if (description.length < 10) throw new Error('Describe what the skill does and when to use it (at least a sentence).');
  if (description.length > MAX_DESCRIPTION) throw new Error(`Keep the description under ${MAX_DESCRIPTION} characters.`);
  if (!draft.instructions.trim()) throw new Error('Write the instructions the agent should follow.');
  return { name, description, instructions: draft.instructions };
}

/**
 * Writes a skill into ~/.maitre/skills. `replaceId` edits an existing user skill (renaming its folder when the name changed)
 * or, for a built-in or Claude Code skill, saves an editable copy that takes its place.
 */
export function saveUserSkill(input: SkillDraft, replaceId?: string, files: SkillFile[] = []): SkillInfo {
  const draft = validDraft(input);
  const target = path.join(userSkillsRoot(), draft.name);
  const previous = replaceId ? skills().find((skill) => skill.id === replaceId) : undefined;
  const editing = previous?.source === 'user' && previous.dir;
  if (fs.existsSync(target) && !(editing && previous.dir === target)) throw new Error(`A skill named "${draft.name}" already exists. Choose another name or edit that skill.`);
  if (editing && previous.dir !== target) fs.renameSync(previous.dir!, target);
  else if (previous?.dir && previous.source !== 'user' && previous.source !== 'builtin') fs.cpSync(previous.dir, target, { recursive: true, filter: (source) => !SKIPPED_DIRS.has(path.basename(source)) });
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) {
    const destination = path.join(target, safeRelative(file.path));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content);
  }
  for (const name of SKILL_FILES) fs.rmSync(path.join(target, name), { force: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), formatSkillFile(draft.name, draft.description, draft.instructions));
  skillsChanged();
  const saved = skills().find((skill) => skill.id === `user:${draft.name}`);
  if (!saved) throw new Error('The skill was written but could not be read back.');
  return visible(saved);
}

export async function deleteUserSkill(id: string): Promise<void> {
  const skill = skills().find((entry) => entry.id === id);
  if (!skill || skill.source !== 'user' || !skill.dir) throw new Error('Only your own skills can be deleted here.');
  await shell.trashItem(skill.dir);
  saveSettings({ disabledSkills: getSettings().disabledSkills.filter((entry) => entry !== id) });
  skillsChanged();
}

export function setSkillEnabled(id: string, enabled: boolean): void {
  const others = getSettings().disabledSkills.filter((entry) => entry !== id);
  saveSettings({ disabledSkills: enabled ? others : [...others, id] });
  skillsChanged();
}

/** Skill folders under `dir`: the folder itself when it has a SKILL.md, else its subfolders (also `skills/*`). */
export function skillFoldersIn(dir: string): string[] {
  if (skillFileIn(dir)) return [dir];
  const direct = subdirs(dir).filter((sub) => skillFileIn(sub));
  return direct.length ? direct : subdirs(path.join(dir, 'skills')).filter((sub) => skillFileIn(sub));
}

/** Copies skill folders into ~/.maitre/skills (a skill with the same name is replaced). */
export function importSkillFolders(folders: string[]): SkillInfo[] {
  if (!folders.length) throw new Error('No SKILL.md found there. A skill is a folder with a SKILL.md file inside.');
  const names = folders.map((dir) => {
    const skill = readSkill(dir, { source: 'user', editable: true });
    if (!skill) throw new Error(`${dir} has a SKILL.md that could not be read.`);
    const target = path.join(userSkillsRoot(), skill.name);
    if (path.resolve(dir) !== path.resolve(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(dir, target, { recursive: true, filter: (source) => !SKIPPED_DIRS.has(path.basename(source)) });
    }
    return skill.name;
  });
  skillsChanged();
  const byName = new Map(skills().filter((skill) => skill.source === 'user').map((skill) => [skill.name, skill]));
  return names.map((name) => byName.get(name)).filter((skill): skill is Skill => Boolean(skill)).map(visible);
}

/** Reads a file inside a skill's folder (no escaping it). */
export function readSkillFile(skill: Skill, file: string): string {
  if (!skill.dir) throw new Error(`${skill.name} is built in and has no extra files.`);
  const target = path.resolve(skill.dir, safeRelative(file));
  const relative = path.relative(skill.dir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('That path is outside the skill folder.');
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return fs.readdirSync(target).join('\n');
  const buffer = fs.readFileSync(target);
  if (buffer.subarray(0, 8000).includes(0)) throw new Error(`${file} is a binary file; in Work mode run or open it from ${target}.`);
  return buffer.toString('utf8');
}
