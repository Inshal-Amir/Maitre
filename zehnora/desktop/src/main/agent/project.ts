import fs from 'node:fs';
import path from 'node:path';
import type { Plan } from '../../shared/types';

/** Per-project memory kept next to the code, so the agent can re-read it instead of relying on a long chat. */
export const PROJECT_DIR = '.zehnora';
const BRIEF = 'brief.md';
const PLAN = 'plan.md';
const NOTES = 'notes.md';
const BRIEF_PROMPT_CHARS = 5000;
const NOTES_PROMPT_CHARS = 3500;

const memoryDir = (root: string): string => path.join(root, PROJECT_DIR);
const file = (root: string, name: string): string => path.join(memoryDir(root), name);

function readOr(target: string, fallback = ''): string {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return fallback;
  }
}

export function hasProject(root: string): boolean {
  return fs.existsSync(memoryDir(root));
}

export function ensureProject(root: string, name: string): { created: boolean } {
  const created = !hasProject(root);
  fs.mkdirSync(memoryDir(root), { recursive: true });
  if (!fs.existsSync(file(root, BRIEF))) fs.writeFileSync(file(root, BRIEF), `# ${name}\n\n(Requirements not written yet.)\n`);
  if (!fs.existsSync(file(root, NOTES))) fs.writeFileSync(file(root, NOTES), `# Notes and decisions\n`);
  const readme = path.join(memoryDir(root), 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, 'Maitre keeps this project\'s brief, plan and notes here so work can continue across chats. Safe to commit or to delete.\n');
  return { created };
}

const MARK: Record<Plan['steps'][number]['status'], string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };

export function planMarkdown(plan: Plan): string {
  return `# Plan\n\n**Goal:** ${plan.goal}\n\n${plan.steps.map((step, index) => `${index + 1}. ${MARK[step.status]} ${step.title}`).join('\n')}\n\n_Updated ${new Date(plan.updatedAt).toISOString()}_\n`;
}

export function writePlan(root: string, plan: Plan): void {
  if (!hasProject(root)) return;
  fs.writeFileSync(file(root, PLAN), planMarkdown(plan));
}

export function writeBrief(root: string, markdown: string): void {
  fs.mkdirSync(memoryDir(root), { recursive: true });
  fs.writeFileSync(file(root, BRIEF), markdown.trim() + '\n');
}

export function addNote(root: string, note: string): void {
  fs.mkdirSync(memoryDir(root), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  fs.appendFileSync(file(root, NOTES), `\n- ${stamp} — ${note.trim().replace(/\n+/g, ' ')}`);
}

const tail = (text: string, max: number): string => (text.length > max ? `…${text.slice(-max)}` : text);
const head = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n…(see ${PROJECT_DIR}/${BRIEF} for the rest)` : text);

/** The project memory block for the system prompt; empty when the working folder is not a Maitre project yet. */
export function projectMemory(root: string, plan: Plan | undefined): string {
  if (!hasProject(root)) return '';
  const brief = readOr(file(root, BRIEF)).trim();
  const notes = readOr(file(root, NOTES)).trim();
  const planText = plan ? planMarkdown(plan) : readOr(file(root, PLAN)).trim();
  return [
    `Project memory (files in ${path.join(root, PROJECT_DIR)}; they are the source of truth — trust them over your recollection of the chat, and keep them current):`,
    `<brief>\n${head(brief, BRIEF_PROMPT_CHARS)}\n</brief>`,
    `<plan>\n${planText || '(no plan yet — create one with update_plan)'}\n</plan>`,
    `<notes>\n${tail(notes, NOTES_PROMPT_CHARS)}\n</notes>`,
  ].join('\n');
}
