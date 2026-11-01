import type { Mode, ToolInfo } from '../../shared/types';
import type { ToolSchema } from '../llm';
import type { Tool } from './types';
import { skillTools } from '../skills/tools';
import { commandTools } from './commands';
import { systemTools } from './system';
import { memoryTools } from '../memory';
import { fileTools } from './files';
import { agentTools } from './agent';
import { webTools } from './web';

const GROUPS: [string, Tool[]][] = [
  ['Planning', agentTools],
  ['Skills', skillTools],
  ['Files', fileTools],
  ['Terminal', commandTools],
  ['Web and GitHub', webTools],
  ['System', systemTools],
  ['Memory', memoryTools],
];

/** Tools the Work workflow and skills rely on; they stay on. */
const LOCKED = new Set(['ask_user', 'set_project', 'update_plan', 'update_brief', 'add_note', 'use_skill', 'read_skill_file']);

const ALL: Tool[] = GROUPS.flatMap(([, tools]) => tools);
const GROUP_OF = new Map(GROUPS.flatMap(([group, tools]) => tools.map((tool): [string, string] => [tool.name, group])));

export function toSchema(tool: Tool): ToolSchema {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

/** The built-in tools of a mode, minus the ones the user switched off. */
export function toolsFor(mode: Mode, disabled: readonly string[] = []): Map<string, Tool> {
  const off = new Set(disabled.filter((name) => !LOCKED.has(name)));
  return new Map(ALL.filter((tool) => tool.modes.includes(mode) && !off.has(tool.name)).map((tool) => [tool.name, tool]));
}

export const schemasFor = (mode: Mode, disabled: readonly string[] = []): ToolSchema[] => [...toolsFor(mode, disabled).values()].map(toSchema);

export function toolInfos(disabled: readonly string[]): ToolInfo[] {
  const off = new Set(disabled);
  return ALL.map((tool) => ({
    name: tool.name,
    description: tool.description,
    group: GROUP_OF.get(tool.name) ?? 'Other',
    modes: tool.modes,
    locked: LOCKED.has(tool.name),
    enabled: LOCKED.has(tool.name) || !off.has(tool.name),
  }));
}

export const isBuiltinTool = (name: string): boolean => GROUP_OF.has(name);
