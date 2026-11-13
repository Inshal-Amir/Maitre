import type { Attachment, Conversation, Message, Settings } from '../../shared/types';
import type { ToolSchema } from '../llm';
import { IMAGE_TOKENS, estimateTokens } from './context';
import { complete } from '../llm';

const START_AT = 0.7;
const KEEP_RECENT = 0.35;
/** Even with a huge context window, history past this is summarized: re-reading it on every step would make each reply slow. */
const START_AT_TOKENS = 128_000;
const KEEP_RECENT_TOKENS = 40_000;
const TOOL_RESULT_CHARS = 1200;
/** Room for the model's reasoning as well as the summary itself. */
const SUMMARY_TOKENS = 12_000;

const SUMMARY_SYSTEM = 'You compress conversations between a user and an AI assistant so the assistant can continue the work later without the full history.';

const SUMMARY_FORMAT = `Write a summary that lets the assistant carry on as if it remembered everything. Same language as the user. Use these sections, as Markdown headings, and skip a section only when it would be empty:
1. Request and intent: what the user asked for, in detail, including changes of mind.
2. Every user message: one line each, in order, close to their own words.
3. Key facts: names, numbers, dates, IDs, email subjects and senders, URLs and anything found with tools that may be needed again.
4. Files and commands: paths that were read or changed (with what changed), commands run and their results.
5. Errors and fixes: what went wrong and how it was solved, including corrections from the user.
6. Decisions and preferences: what was agreed and how the user wants things done.
7. Open work: what is still to do, and the exact step that was in progress at the end.
Be specific and complete; leave out pleasantries. At most 900 words.`;

const attachmentTokens = (files: Attachment[] = []): number =>
  files.reduce((sum, file) => sum + (file.kind === 'image' ? IMAGE_TOKENS : Math.min(60_000, file.text?.length ?? 0) / 3.2), 0);

const messageTokens = (message: Message): number =>
  message.role === 'user'
    ? estimateTokens(message.content) + attachmentTokens(message.attachments) + 4
    : estimateTokens(message.content) + message.toolCalls.reduce((sum, call) => sum + estimateTokens(call.arguments) + estimateTokens(call.result ?? '') + 12, 4);

function firstLines(files: Attachment[]): string {
  const text = files.find((file) => file.kind !== 'image')?.text;
  return text ? `; first lines: ${text.slice(0, 1500).replace(/\s+/g, ' ')}` : '';
}

function transcript(messages: Message[]): string {
  return messages
    .map((message) => {
      if (message.role === 'user') return `USER: ${message.content}${message.attachments?.length ? ` [attached: ${message.attachments.map((file) => file.name).join(', ')}${firstLines(message.attachments)}]` : ''}`;
      const calls = message.toolCalls.map((call) => `  → ${call.name}(${call.arguments.slice(0, 200)}) [${call.status}]: ${(call.result ?? '').slice(0, TOOL_RESULT_CHARS).replace(/\s+/g, ' ')}`);
      return [message.content ? `ASSISTANT: ${message.content}` : 'ASSISTANT (tools):', ...calls].join('\n');
    })
    .join('\n');
}

/** Index of the first message to keep verbatim: a user message, with the kept tail inside the recent-message budget. */
function cutIndex(messages: Message[], from: number, keepTokens: number): number {
  let kept = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i > from; i--) {
    kept += messageTokens(messages[i]);
    if (kept > keepTokens) break;
    if (messages[i].role === 'user') cut = i;
  }
  return cut;
}

/**
 * Keeps long chats fast and inside the model's context window: once the history passes 70 % of the budget (or 128K tokens),
 * the older part is replaced by a model-written summary (stored on the conversation) and only the recent turns stay verbatim.
 * Returns true when a new summary was written.
 */
export async function compactIfNeeded(conversation: Conversation, settings: Settings, apiKey: string, system: string, tools: ToolSchema[], signal: AbortSignal, onStart: () => void = () => undefined): Promise<boolean> {
  const budget = settings.contextTokens - settings.maxOutputTokens - estimateTokens(system) - estimateTokens(JSON.stringify(tools));
  const from = conversation.summary?.upTo ?? 0;
  const history = conversation.messages.slice(from).reduce((sum, message) => sum + messageTokens(message), estimateTokens(conversation.summary?.text ?? ''));
  if (history < Math.min(budget * START_AT, START_AT_TOKENS)) return false;
  const cut = cutIndex(conversation.messages, from, Math.min(budget * KEEP_RECENT, KEEP_RECENT_TOKENS));
  if (cut - from < 2) return false;

  onStart();
  const previous = conversation.summary?.text ? `Summary so far:\n${conversation.summary.text}\n\nNew part of the conversation:\n` : '';
  const result = await complete(
    {
      apiBase: settings.apiBase,
      apiKey,
      model: settings.model,
      tools: [],
      maxTokens: SUMMARY_TOKENS,
      signal,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `${previous}${transcript(conversation.messages.slice(from, cut))}\n\n${SUMMARY_FORMAT}` },
      ],
    },
    { onContent: () => undefined, onReasoning: () => undefined, onToolCalls: () => undefined },
  );
  const text = result.content.trim();
  if (!text) return false;
  conversation.summary = { text, upTo: cut };
  return true;
}
