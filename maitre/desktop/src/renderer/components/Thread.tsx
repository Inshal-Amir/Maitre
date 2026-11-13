import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ApprovalRequest, AssistantMessage, Message, Plan, QuestionRequest, WaitState } from '../../shared/types';
import { PlanPanel } from './Questions';
import { ToolCard } from './ToolCard';
import { Markdown } from './Markdown';
import { Icon } from './Icon';
import { AttachmentIcon, describeAttachment } from './Composer';

type Turn = { kind: 'user'; message: Message; start: number } | { kind: 'assistant'; id: string; steps: AssistantMessage[]; start: number };

function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      turns.push({ kind: 'user', message, start: index });
      return;
    }
    const last = turns[turns.length - 1];
    if (last?.kind === 'assistant') last.steps.push(message);
    else turns.push({ kind: 'assistant', id: message.id, steps: [message], start: index });
  });
  return turns;
}

const PREVIEW_CHARS = 220;

function Reasoning({ text, live }: { text: string; live: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  const preview = text.length > PREVIEW_CHARS ? `…${text.slice(-PREVIEW_CHARS)}` : text;
  return (
    <div className="reasoning">
      <button type="button" className="reasoning-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="brain" size={14} />
        <span className={live ? 'shimmer' : ''}>{live ? 'Thinking…' : 'Thought process'}</span>
        <Icon name="chevron" size={13} className={`tool-chevron ${open ? 'open' : ''}`} />
      </button>
      {open ? <div className="reasoning-body">{text}</div> : live && <div className="reasoning-live">{preview}</div>}
    </div>
  );
}

function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}

const formatTokens = (tokens: number): string => (tokens < 1000 ? `${tokens}` : `${Math.round(tokens / 1000)}k`);

/** How fast the Maitre server reads a prompt it has not seen before (measured on the DGX Spark). */
const READ_TOKENS_PER_SECOND = 350;

const formatDuration = (seconds: number): string => (seconds < 90 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)} min`);

function waitingText({ phase, tokens, afterTools }: WaitState, seconds: number): string {
  if (phase === 'compacting') return 'Summarizing earlier messages so the chat stays fast…';
  const size = tokens ? ` (~${formatTokens(tokens)} tokens)` : '';
  const expected = (tokens ?? 0) / READ_TOKENS_PER_SECOND;
  if (seconds >= Math.max(120, expected * 1.5 + 60)) return `No reply after ${formatDuration(seconds)}. The server may be busy with another request or restarting. You can press Stop and try again.`;
  if (seconds >= 25 && expected >= 60) return `Reading a long conversation${size}: ${formatDuration(seconds)} of about ${formatDuration(expected)}. The first reply after a pause takes longest; the next ones reuse what was read.`;
  if (seconds >= 25) return `Still reading the conversation${size}, ${seconds}s. Long chats take longer before the first word.`;
  return afterTools ? `Reading the tool results and deciding the next step${size}…` : `Reading your message${size}…`;
}

function Waiting({ wait }: { wait: WaitState }): ReactElement {
  const seconds = useElapsed(true);
  return (
    <div className="waiting" role="status">
      <div className="typing"><span /><span /><span /></div>
      <span>{waitingText(wait, seconds)}</span>
    </div>
  );
}

function Step({ step, approvals, questions, waiting, onRetry }: { step: AssistantMessage; approvals: Map<string, ApprovalRequest>; questions: Map<string, QuestionRequest>; waiting: WaitState | undefined; onRetry?: () => void }): ReactElement {
  const thinking = step.streaming && !step.content && !step.toolCalls.length;
  return (
    <div className="step">
      {step.reasoning && <Reasoning text={step.reasoning} live={Boolean(thinking)} />}
      {!step.reasoning && thinking && (waiting ? <Waiting wait={waiting} /> : <div className="typing"><span /><span /><span /></div>)}
      {step.content && (
        <div className={step.streaming ? 'streaming' : undefined}>
          <Markdown text={step.content} />
        </div>
      )}
      {step.toolCalls.length > 0 && (
        <div className="tools">
          {step.toolCalls.map((call) => <ToolCard key={call.id} call={call} approval={approvals.get(call.id)} question={questions.get(call.id)} />)}
        </div>
      )}
      {step.error && (
        <div className="step-error" role="alert">
          <span>{step.error}</span>
          {onRetry && <button type="button" className="btn small" onClick={onRetry}><Icon name="refresh" size={14} /> Retry</button>}
        </div>
      )}
    </div>
  );
}

export function Thread({ messages, approvals, questions, plan, waiting, onRetry, compactedAt }: {
  messages: Message[];
  approvals: ApprovalRequest[];
  questions: QuestionRequest[];
  plan?: Plan;
  waiting?: WaitState;
  /** Set while the chat is idle: offered on the error of its last step. */
  onRetry?: () => void;
  compactedAt?: number;
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const turns = useMemo(() => toTurns(messages), [messages]);
  const lastId = messages[messages.length - 1]?.id;
  const approvalByCall = useMemo(() => new Map(approvals.map((request) => [request.toolCallId, request])), [approvals]);
  const questionByCall = useMemo(() => new Map(questions.map((request) => [request.toolCallId, request])), [questions]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onScroll = (): void => {
      stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [messages, approvals, questions, waiting]);

  return (
    <div className="thread" ref={scroller}>
      <div className="thread-inner">
        {plan && plan.steps.length > 0 && <PlanPanel plan={plan} />}
        {turns.map((turn) => (
          <Fragment key={turn.kind === 'user' ? turn.message.id : turn.id}>
            {compactedAt !== undefined && compactedAt > 0 && turn.start === compactedAt && (
              <div className="compacted" role="note">Earlier messages were summarized to keep this chat fast. Maitre still has the key points.</div>
            )}
            {turn.kind === 'user' ? (
              <div className="turn user">
                <div className="user-stack">
                  {turn.message.role === 'user' && turn.message.attachments?.map((file) => file.kind === 'image' && file.dataUrl ? (
                    <img key={file.id} className="sent-image" src={file.dataUrl} alt={file.name} title={file.name} />
                  ) : (
                    <div key={file.id} className="attachment sent" title={file.path}>
                      <AttachmentIcon file={file} />
                      <span className="attachment-text"><b>{file.name}</b><small>{describeAttachment(file)}</small></span>
                    </div>
                  ))}
                  {turn.message.role === 'user' && turn.message.skill && (
                    <div className="skill-chip" title={turn.message.skill.dir ?? 'Built-in skill'}><Icon name="book" size={13} /> {turn.message.skill.name}</div>
                  )}
                  <div className="bubble">{turn.message.content}</div>
                </div>
              </div>
            ) : (
              <div className="turn assistant">
                <div className="avatar" aria-hidden="true" />
                <div className="steps">
                  {turn.steps.map((step, index) => <Step key={step.id} step={step} approvals={approvalByCall} questions={questionByCall} waiting={index === turn.steps.length - 1 ? waiting : undefined} onRetry={step.id === lastId ? onRetry : undefined} />)}
                </div>
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
