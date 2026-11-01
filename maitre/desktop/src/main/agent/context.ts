import type { ApiMessage, ContentPart, ToolSchema } from '../llm';
import type { InvokedSkill, Message, Mode, ToolCall, UserMessage } from '../../shared/types';

const CHARS_PER_TOKEN = 3.2;
const RECENT_TOOL_RESULTS = 8;
const SHRUNK_RESULT_CHARS = 700;

/** What one image costs the model, whatever its file size (the vision encoder resizes it). */
export const IMAGE_TOKENS = 1500;
/** Images are sent only with the latest user turns; older ones stay as a note. */
const IMAGE_TURNS = 3;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export const contentTokens = (content: string | ContentPart[]): number =>
  typeof content === 'string' ? estimateTokens(content) : content.reduce((sum, part) => sum + (part.type === 'text' ? estimateTokens(part.text) : IMAGE_TOKENS), 0);

function toolResultText(call: ToolCall): string {
  if (call.status === 'denied') return 'The user denied this action. Do not retry it; choose another approach or explain what is needed.';
  if (call.status === 'cancelled') return 'Cancelled by the user.';
  if (call.status === 'error') return `Error: ${call.result ?? 'unknown error'}`;
  return call.result ?? '(no result)';
}

const INLINE_CHARS = 60_000;

/** A user message as the model sees it: the text plus the extracted content of attached files (shared inline budget). */
export function userContent(message: UserMessage, mode: Mode): string {
  const text = message.skill ? `${skillBlock(message.skill, mode)}\n\n${message.content}` : message.content;
  const documents = (message.attachments ?? []).filter((file) => file.kind !== 'image');
  if (!documents.length) return text;
  let left = INLINE_CHARS;
  const blocks = documents.map((file) => {
    const text = file.text ?? '';
    const shown = text.slice(0, Math.max(0, left));
    left -= shown.length;
    const meta = `${file.name}${file.pages ? `, ${file.pages} pages` : ''}, ${file.chars.toLocaleString('en')} characters, saved at ${file.path}`;
    const cut = shown.length < text.length || file.truncated;
    const more = !cut ? '' : mode === 'work' ? `\n[… only the first ${shown.length.toLocaleString('en')} characters are shown here; read the rest with read_file on ${file.path} using offset/limit]` : `\n[… only the first ${shown.length.toLocaleString('en')} characters are shown; the rest was left out to fit the model's memory]`;
    return `<attached_file name="${file.name}">\n(${meta})\n${shown}${more}\n</attached_file>`;
  });
  return `${text}\n\n${blocks.join('\n\n')}`;
}

/** The user turn with its images as vision parts; with `showImages` false the images are only named. */
export function userParts(message: UserMessage, mode: Mode, showImages: boolean): string | ContentPart[] {
  const text = userContent(message, mode);
  const images = (message.attachments ?? []).filter((file) => file.kind === 'image' && file.dataUrl);
  if (!images.length) return text;
  if (!showImages) return `${text}\n\n${images.map((file) => `[image: ${file.name} — no longer shown]`).join('\n')}`;
  return [{ type: 'text', text }, ...images.map((file): ContentPart => ({ type: 'image_url', image_url: { url: file.dataUrl! } }))];
}

/** The instructions of a skill the user called with `/name`, in front of their message. */
function skillBlock(skill: InvokedSkill, mode: Mode): string {
  const folder = skill.dir ? `\n(Skill folder: ${skill.dir}${mode === 'chat' ? '; read its files with read_skill_file' : ''})` : '';
  return `<skill name="${skill.name}">\nThe user ran the skill /${skill.name}${skill.arguments ? ` with: ${skill.arguments}` : ''}. Follow these instructions for this request.${folder}\n\n${skill.instructions}\n</skill>`;
}

/** One user turn, or one assistant step with its tool results; groups are dropped whole so tool results stay paired. */
type Group = ApiMessage[];

function toGroups(messages: Message[], mode: Mode): Group[] {
  const groups: Group[] = [];
  let userTurnsLeft = messages.reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0);
  for (const message of messages) {
    if (message.role === 'user') {
      groups.push([{ role: 'user', content: userParts(message, mode, userTurnsLeft <= IMAGE_TURNS) }]);
      userTurnsLeft--;
      continue;
    }
    const calls = message.toolCalls.filter((call) => call.status !== 'pending');
    if (!message.content && !calls.length) continue;
    const group: Group = [
      {
        role: 'assistant',
        content: message.content || null,
        ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments || '{}' } })) } : {}),
      },
    ];
    for (const call of calls) group.push({ role: 'tool', tool_call_id: call.id, content: toolResultText(call) });
    groups.push(group);
  }
  return groups;
}

const sizeOf = (message: ApiMessage): number => {
  if (message.role === 'assistant') return estimateTokens((message.content ?? '') + JSON.stringify(message.tool_calls ?? '')) + 4;
  return contentTokens(message.content) + 4;
};

function shrinkOldToolResults(groups: Group[]): void {
  let seen = 0;
  for (let g = groups.length - 1; g >= 0; g--) {
    for (let m = groups[g].length - 1; m >= 0; m--) {
      const message = groups[g][m];
      if (message.role !== 'tool') continue;
      seen++;
      if (seen <= RECENT_TOOL_RESULTS || message.content.length <= SHRUNK_RESULT_CHARS) continue;
      groups[g][m] = { ...message, content: `${message.content.slice(0, SHRUNK_RESULT_CHARS)}\n… [older tool output shortened to save context; run the tool again if you need it]` };
    }
  }
}

/**
 * Builds the request messages within the context budget: first older tool outputs are shortened,
 * then the oldest turns are dropped (the first user message is kept for the task statement).
 */
export function buildMessages(system: string, messages: Message[], tools: ToolSchema[], contextTokens: number, maxOutputTokens: number, summary?: { text: string; upTo: number }, mode: Mode = 'chat'): ApiMessage[] {
  const budget = contextTokens - maxOutputTokens - estimateTokens(system) - estimateTokens(JSON.stringify(tools));
  const groups = toGroups(summary ? messages.slice(summary.upTo) : messages, mode);
  if (summary) groups.unshift([{ role: 'user', content: `[Summary of the earlier part of this conversation, written to save space]\n${summary.text}` }]);
  const total = (): number => groups.reduce((sum, group) => sum + group.reduce((s, m) => s + sizeOf(m), 0), 0);
  if (total() > budget) shrinkOldToolResults(groups);
  let dropped = 0;
  while (groups.length > 2 && total() > budget) {
    groups.splice(1, 1);
    dropped++;
  }
  while (groups.length > 1 && groups[1][0].role === 'tool') groups.splice(1, 1);
  const notice: ApiMessage[] = dropped ? [{ role: 'user', content: `[${dropped} earlier step(s) of this conversation were removed to fit the context window. Re-read files if you need details.]` }] : [];
  const [first, ...rest] = groups;
  return [{ role: 'system', content: system }, ...(first ?? []), ...notice, ...rest.flat()];
}
