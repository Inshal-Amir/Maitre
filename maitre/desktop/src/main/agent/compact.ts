import type { Conversation, Message, Settings } from '../../shared/types';
import type { ToolSchema } from '../llm';
import { estimateTokens } from './context';
import { complete } from '../llm';

const START_AT = 0.7;
const KEEP_RECENT = 0.35;
const TOOL_RESULT_CHARS = 400;
const SUMMARY_TOKENS = 3000;

const messageTokens = (message: Message): number =>
  message.role === 'user'
    ? estimateTokens(message.content) + Math.min(60_000, (message.attachments ?? []).reduce((sum, file) => sum + (file.text?.length ?? 0), 0)) / 3.2 + 4
    : estimateTokens(message.content) + message.toolCalls.reduce((sum, call) => sum + estimateTokens(call.arguments) + estimateTokens(call.result ?? '') + 12, 4);

function transcript(messages: Message[]): string {
  return messages
    .map((message) => {
      if (message.role === 'user') return `USER: ${message.content}${message.attachments?.length ? ` [attached: ${message.attachments.map((file) => file.name).join(', ')}; first lines: ${(message.attachments[0].text ?? '').slice(0, 1500).replace(/\s+/g, ' ')}]` : ''}`;
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
 * Keeps long chats inside the model's context window: once the history passes 70 % of the budget,
 * the older part is replaced by a model-written summary (stored on the conversation) and only the recent turns stay verbatim.
 * Returns true when a new summary was written.
 */
export async function compactIfNeeded(conversation: Conversation, settings: Settings, apiKey: string, system: string, tools: ToolSchema[], signal: AbortSignal, onStart: () => void = () => undefined): Promise<boolean> {
  const budget = settings.contextTokens - settings.maxOutputTokens - estimateTokens(system) - estimateTokens(JSON.stringify(tools));
  const from = conversation.summary?.upTo ?? 0;
  const history = conversation.messages.slice(from).reduce((sum, message) => sum + messageTokens(message), estimateTokens(conversation.summary?.text ?? ''));
  if (history < budget * START_AT) return false;
  const cut = cutIndex(conversation.messages, from, budget * KEEP_RECENT);
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
        { role: 'system', content: 'You compress conversations between a user and an AI assistant so the assistant can continue the work later without the full history.' },
        {
          role: 'user',
          content: `${previous}${transcript(conversation.messages.slice(from, cut))}\n\nWrite a compact summary (at most 350 words, same language as the user) that keeps: the user's goals and preferences, decisions made, important facts and numbers, file paths, commands run and their outcomes, and what is still open. Plain bullet points, no preamble.`,
        },
      ],
    },
    { onContent: () => undefined, onReasoning: () => undefined, onToolCalls: () => undefined },
  );
  const text = result.content.trim();
  if (!text) return false;
  conversation.summary = { text, upTo: cut };
  return true;
}
