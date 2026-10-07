import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { PlanStatus, PlanStep, Question } from '../../shared/types';
import type { Args, ArgValue, Tool, ToolContext } from './types';
import { ToolError, optStr, str } from './types';
import { isInside, isSensitivePath, resolvePath } from './policy';
import { PROJECT_DIR, addNote, ensureProject, hasProject, projectMemory, writeBrief, writePlan } from '../agent/project';

const MAX_QUESTIONS = 6;
const MAX_STEPS = 20;
const STATUSES = new Set<PlanStatus>(['pending', 'in_progress', 'completed']);

function hooks(context: ToolContext): NonNullable<ToolContext['agent']> {
  if (!context.agent) throw new ToolError('This tool is only available inside an agent run.');
  return context.agent;
}

const asObjects = (value: ArgValue | undefined, key: string): { [key: string]: ArgValue }[] => {
  if (!Array.isArray(value)) throw new ToolError(`"${key}" must be a list.`);
  return value.map((item) => {
    if (typeof item === 'string') return { question: item, title: item };
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolError(`Each entry in "${key}" must be an object.`);
    return item;
  });
};

function parseQuestions(args: Args): Question[] {
  const questions = asObjects(args.questions, 'questions').slice(0, MAX_QUESTIONS).map((item) => ({
    question: String(item.question ?? '').trim(),
    options: Array.isArray(item.options) ? item.options.map(String).filter(Boolean).slice(0, 8) : undefined,
    multiple: item.multiple === true,
  }));
  if (!questions.length || questions.some((q) => !q.question)) throw new ToolError('Give at least one question with a "question" text.');
  return questions;
}

const askUser: Tool = {
  name: 'ask_user',
  description:
    'Ask the user focused questions and WAIT for the answers before continuing (the app shows them as a form with clickable options). ' +
    'Use it to clarify requirements before building, to confirm the project folder, to get approval of a plan, or when you are stuck on a choice only the user can make. ' +
    'Ask 1-5 short questions at once; give 2-5 concrete options per question where possible (the user can always type their own answer).',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'One line shown above the questions, e.g. "A few details about your website"' },
      questions: {
        type: 'array',
        description: 'The questions',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question' },
            options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers (optional)' },
            multiple: { type: 'boolean', description: 'Allow choosing several options' },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
  modes: ['chat', 'work'],
  assess: (args) => ({ risk: 'safe', title: optStr(args, 'title', 'Questions for you'), detail: '', allowKey: 'ask' }),
  async run(args, context) {
    const questions = parseQuestions(args);
    const answers = await hooks(context).ask(optStr(args, 'title', 'A few questions'), questions);
    if (!answers) throw new ToolError('The user did not answer (the run was stopped).');
    return questions.map((q, index) => `Q: ${q.question}\nA: ${answers[index]?.trim() || '(no answer — use your best judgement and say so)'}`).join('\n\n');
  },
};

function projectRisk(dir: string, context: ToolContext): 'normal' | 'risky' {
  if (isSensitivePath(dir, context.cwd)) return 'risky';
  return isInside(dir, os.homedir()) ? 'normal' : 'risky';
}

const setProject: Tool = {
  name: 'set_project',
  description:
    `Choose the project folder for this task (agree it with the user first). Creates the folder if needed and a ${PROJECT_DIR}/ memory folder inside it ` +
    '(brief, plan, notes). All later relative paths and commands use this folder. If the folder already has code, it is reported so you can build on it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path or ~/..., e.g. ~/Maitre/portfolio-site' },
      name: { type: 'string', description: 'Human name of the project' },
    },
    required: ['path'],
  },
  modes: ['work'],
  assess(args, context) {
    const dir = resolvePath(str(args, 'path'), context.cwd);
    return { risk: projectRisk(dir, context), title: `Use project folder ${dir}`, detail: '', allowKey: `project:${dir}` };
  },
  async run(args, context) {
    const dir = resolvePath(str(args, 'path'), context.cwd);
    if (dir === path.parse(dir).root || dir === os.homedir()) throw new ToolError('Pick a dedicated folder, not the disk root or the home folder.');
    const existed = fs.existsSync(dir) && fs.readdirSync(dir).some((entry) => entry !== PROJECT_DIR && entry !== '.DS_Store');
    fs.mkdirSync(dir, { recursive: true });
    const name = optStr(args, 'name', path.basename(dir));
    const hadMemory = hasProject(dir);
    ensureProject(dir, name);
    hooks(context).setProject(dir);
    const entries = existed ? fs.readdirSync(dir).filter((entry) => entry !== PROJECT_DIR).slice(0, 40).join(', ') : '';
    return [
      `Project folder set: ${dir}`,
      existed ? `The folder already contains: ${entries}. Inspect it before changing anything.` : 'The folder was empty; start fresh.',
      hadMemory ? `Existing project memory found:\n${projectMemory(dir, hooks(context).getPlan())}` : `Created ${PROJECT_DIR}/brief.md and ${PROJECT_DIR}/notes.md. Next: write the requirements with update_brief and a plan with update_plan.`,
    ].join('\n');
  },
};

function parseSteps(args: Args): PlanStep[] {
  const steps = asObjects(args.steps, 'steps').slice(0, MAX_STEPS).map((item) => {
    const title = String(item.title ?? item.step ?? item.question ?? '').trim();
    const status = String(item.status ?? 'pending') as PlanStatus;
    return { title, status: STATUSES.has(status) ? status : 'pending' };
  });
  if (!steps.length || steps.some((step) => !step.title)) throw new ToolError('Give the plan as a list of steps with a "title".');
  return steps;
}

const updatePlan: Tool = {
  name: 'update_plan',
  description:
    'Create or update the task plan (shown to the user as a checklist and saved to .zehnora/plan.md). Send the FULL list every time. ' +
    'Statuses: pending, in_progress (exactly one step at a time), completed. Update it when you start and finish each step, and when the plan changes.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'One sentence: what "done" means for the user' },
      steps: {
        type: 'array',
        description: '3-12 concrete steps',
        items: { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['title'] },
      },
    },
    required: ['steps'],
  },
  modes: ['work'],
  assess: () => ({ risk: 'safe', title: 'Update plan', detail: '', allowKey: 'plan' }),
  async run(args, context) {
    const agent = hooks(context);
    const steps = parseSteps(args);
    const goal = optStr(args, 'goal', agent.getPlan()?.goal ?? '');
    const plan = { goal, steps, updatedAt: Date.now() };
    agent.setPlan(plan);
    writePlan(context.cwd, plan);
    const done = steps.filter((step) => step.status === 'completed').length;
    const active = steps.filter((step) => step.status === 'in_progress').length;
    const warning = active > 1 ? '\nWarning: more than one step is in_progress; keep exactly one.' : '';
    return `Plan saved (${done}/${steps.length} done).${warning}${hasProject(context.cwd) ? '' : '\nNote: no project folder yet, so the plan is not saved to disk; call set_project.'}`;
  },
};

const updateBrief: Tool = {
  name: 'update_brief',
  description:
    'Write the project brief (.zehnora/brief.md): the agreed requirements in Markdown — purpose, audience, features/pages, tech stack, design/style, content, constraints, and how it will be run or deployed. Rewrite it whenever requirements change.',
  parameters: { type: 'object', properties: { markdown: { type: 'string', description: 'The complete brief in Markdown' } }, required: ['markdown'] },
  modes: ['work'],
  assess: () => ({ risk: 'safe', title: 'Update project brief', detail: '', allowKey: 'brief' }),
  async run(args, context) {
    if (!hasProject(context.cwd)) throw new ToolError('Choose the project folder with set_project first.');
    writeBrief(context.cwd, str(args, 'markdown'));
    return `Brief saved to ${path.join(context.cwd, PROJECT_DIR, 'brief.md')}.`;
  },
};

const addNoteTool: Tool = {
  name: 'add_note',
  description:
    'Record a decision, finding or lesson in .zehnora/notes.md (e.g. "Using Tailwind v4: config lives in CSS", "Port 5173 is the dev server", "Fixed CORS by ..."). Keep notes short; they are re-read on every step.',
  parameters: { type: 'object', properties: { note: { type: 'string', description: 'One short note' } }, required: ['note'] },
  modes: ['work'],
  assess: () => ({ risk: 'safe', title: 'Add project note', detail: '', allowKey: 'note' }),
  async run(args, context) {
    if (!hasProject(context.cwd)) throw new ToolError('Choose the project folder with set_project first.');
    addNote(context.cwd, str(args, 'note'));
    return 'Note saved.';
  },
};

export const agentTools: Tool[] = [askUser, setProject, updatePlan, updateBrief, addNoteTool];
