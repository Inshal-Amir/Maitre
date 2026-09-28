import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ApprovalRequest, AssistantMessage, Message } from '../../shared/types';
import { ToolCard } from './ToolCard';
import { Markdown } from './Markdown';
import { Icon } from './Icon';

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

function Waiting({ phase }: { phase: 'compacting' | 'model' }): ReactElement {
  const seconds = useElapsed(true);
  const text = phase === 'compacting'
    ? 'Summarizing earlier messages so the chat stays fast…'
    : seconds < 20 ? 'Waiting for Zehnora…' : `Still waiting for the model (${seconds}s). It may be busy with another request.`;
  return (
    <div className="waiting" role="status">
      <div className="typing"><span /><span /><span /></div>
      <span>{text}</span>
    </div>
  );
}

function Step({ step, approvals, waiting }: { step: AssistantMessage; approvals: Map<string, ApprovalRequest>; waiting: 'compacting' | 'model' | undefined }): ReactElement {
  const thinking = step.streaming && !step.content && !step.toolCalls.length;
  return (
    <div className="step">
      {step.reasoning && <Reasoning text={step.reasoning} live={Boolean(thinking)} />}
      {!step.reasoning && thinking && (waiting ? <Waiting phase={waiting} /> : <div className="typing"><span /><span /><span /></div>)}
      {step.content && (
        <div className={step.streaming ? 'streaming' : undefined}>
          <Markdown text={step.content} />
        </div>
      )}
      {step.toolCalls.length > 0 && (
        <div className="tools">
          {step.toolCalls.map((call) => <ToolCard key={call.id} call={call} approval={approvals.get(call.id)} />)}
        </div>
      )}
      {step.error && <div className="step-error" role="alert">{step.error}</div>}
    </div>
  );
}

export function Thread({ messages, approvals, waiting, compactedAt }: {
  messages: Message[];
  approvals: ApprovalRequest[];
  waiting?: 'compacting' | 'model';
  compactedAt?: number;
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const turns = useMemo(() => toTurns(messages), [messages]);
  const approvalByCall = useMemo(() => new Map(approvals.map((request) => [request.toolCallId, request])), [approvals]);

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
  }, [messages, approvals, waiting]);

  return (
    <div className="thread" ref={scroller}>
      <div className="thread-inner">
        {turns.map((turn) => (
          <Fragment key={turn.kind === 'user' ? turn.message.id : turn.id}>
            {compactedAt !== undefined && compactedAt > 0 && turn.start === compactedAt && (
              <div className="compacted" role="note">Earlier messages were summarized to keep this chat fast. Zehnora still has the key points.</div>
            )}
            {turn.kind === 'user' ? (
              <div className="turn user">
                <div className="bubble">{turn.message.content}</div>
              </div>
            ) : (
              <div className="turn assistant">
                <div className="avatar" aria-hidden="true">Z</div>
                <div className="steps">
                  {turn.steps.map((step, index) => <Step key={step.id} step={step} approvals={approvalByCall} waiting={index === turn.steps.length - 1 ? waiting : undefined} />)}
                </div>
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
