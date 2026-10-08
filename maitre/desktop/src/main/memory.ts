import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import type { Memory } from '../shared/types';
import type { Tool } from './tools/types';
import { ToolError, str } from './tools/types';
import { getSettings } from './settings';

const MAX_MEMORIES = 60;
const MAX_LENGTH = 300;

const file = (): string => path.join(app.getPath('userData'), 'memories.json');

let cache: Memory[] | null = null;
let onChange: (memories: Memory[]) => void = () => undefined;

export function watchMemories(listener: (memories: Memory[]) => void): void {
  onChange = listener;
}

export function listMemories(): Memory[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8')) as Memory[];
  } catch {
    cache = [];
  }
  return cache;
}

function persist(next: Memory[]): void {
  cache = next;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  onChange(next);
}

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

export function addMemory(text: string): Memory {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH);
  if (!clean) throw new ToolError('Nothing to remember.');
  const existing = listMemories().find((memory) => normalize(memory.text) === normalize(clean));
  if (existing) return existing;
  const memory: Memory = { id: crypto.randomBytes(4).toString('hex'), text: clean, createdAt: Date.now() };
  persist([...listMemories(), memory].slice(-MAX_MEMORIES));
  return memory;
}

export function deleteMemory(id: string): boolean {
  const before = listMemories();
  const next = before.filter((memory) => memory.id !== id);
  if (next.length === before.length) return false;
  persist(next);
  return true;
}

export function clearMemories(): void {
  persist([]);
}

/** The system-prompt block with what the user asked Maitre to remember; empty when memory is off. */
export function memoryPrompt(): string {
  if (!getSettings().memoryEnabled) return '';
  const memories = listMemories();
  const rules = 'Memory: when the user asks you to remember something, or shares a lasting preference or fact about themselves (name, language, job, projects, tools they use), save it with the remember tool and say so briefly. Never save passwords, keys or other secrets. Use forget_memory when the user asks you to forget something.';
  if (!memories.length) return rules;
  return `${rules}\nWhat you remember about the user (id: note):\n${memories.map((memory) => `- ${memory.id}: ${memory.text}`).join('\n')}`;
}

const SECRET_LIKE = /(sk-[a-z0-9_-]{12,}|ghp_[a-z0-9]{20,}|gho_[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|password\s*[:=]|api[_ -]?key\s*[:=]|-----BEGIN)/i;

export const memoryTools: Tool[] = [
  {
    name: 'remember',
    description: 'Save one short, lasting fact or preference about the user to memory (e.g. "Prefers answers in Roman Urdu", "Works on the Maitre project"). One fact per call.',
    parameters: { type: 'object', properties: { fact: { type: 'string', description: 'The fact, written as a short third-person note' } }, required: ['fact'] },
    modes: ['chat', 'work'],
    assess: (args) => ({ risk: 'safe', title: `Remember: ${String(args.fact ?? '').slice(0, 80)}`, detail: '', allowKey: 'memory' }),
    async run(args) {
      if (!getSettings().memoryEnabled) throw new ToolError('Memory is turned off in Settings; tell the user you cannot remember this.');
      const fact = str(args, 'fact');
      if (SECRET_LIKE.test(fact)) throw new ToolError('That looks like a secret (password or key); secrets are never saved to memory.');
      const memory = addMemory(fact);
      return `Saved to memory (id ${memory.id}): ${memory.text}`;
    },
  },
  {
    name: 'forget_memory',
    description: 'Delete one saved memory by its id (ids are listed in the Memory section of your instructions).',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'Memory id' } }, required: ['id'] },
    modes: ['chat', 'work'],
    assess: (args) => ({ risk: 'safe', title: `Forget memory ${String(args.id ?? '')}`, detail: '', allowKey: 'memory' }),
    run: async (args) => (deleteMemory(str(args, 'id')) ? 'Memory deleted.' : 'No memory with that id.'),
  },
];
