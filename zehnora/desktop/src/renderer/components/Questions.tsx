import { useState } from 'react';
import type { ReactElement } from 'react';
import type { Plan, QuestionRequest } from '../../shared/types';
import { Icon } from './Icon';
import { api } from '../state';

const PATH_LIKE = /^(~|\/|[A-Za-z]:\\)/;
const isFolderQuestion = (question: QuestionRequest['questions'][number]): boolean =>
  /folder|directory|path|where should|kahan/i.test(question.question) || Boolean(question.options?.some((option) => PATH_LIKE.test(option)));

/** The agent's ask_user form: options as chips, an own-answer field per question, one submit. */
export function QuestionBox({ request }: { request: QuestionRequest }): ReactElement {
  const [picked, setPicked] = useState<string[][]>(request.questions.map(() => []));
  const [typed, setTyped] = useState<string[]>(request.questions.map(() => ''));

  const toggle = (index: number, option: string, multiple: boolean): void =>
    setPicked((all) => all.map((list, i) => (i !== index ? list : multiple ? (list.includes(option) ? list.filter((o) => o !== option) : [...list, option]) : list[0] === option ? [] : [option])));

  const answers = request.questions.map((_, index) => [...picked[index], typed[index].trim()].filter(Boolean).join('; '));
  const complete = answers.every(Boolean);

  return (
    <div className="question" role="form" aria-label={request.title}>
      <div className="question-head">
        <Icon name="chat" size={16} />
        <span>{request.title}</span>
      </div>
      {request.questions.map((question, index) => (
        <div key={question.question} className="question-item">
          <div className="question-text">{index + 1}. {question.question}</div>
          {question.options?.length ? (
            <div className="question-options">
              {question.options.map((option) => (
                <button key={option} type="button" className={`option ${PATH_LIKE.test(option) ? 'path' : ''} ${picked[index].includes(option) ? 'on' : ''}`} onClick={() => toggle(index, option, Boolean(question.multiple))}>
                  {option}
                </button>
              ))}
            </div>
          ) : null}
          {isFolderQuestion(question) && (
            <button type="button" className="btn small browse" onClick={async () => {
              const dir = await api().chooseDirectory();
              if (dir) setTyped((all) => all.map((value, i) => (i === index ? dir : value)));
            }}>Browse…</button>
          )}
          <input
            className="question-input"
            value={typed[index]}
            placeholder={question.options?.length ? 'Or write your own answer…' : 'Your answer…'}
            onChange={(event) => setTyped((all) => all.map((value, i) => (i === index ? event.target.value : value)))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && complete) api().answer(request.id, answers);
            }}
          />
        </div>
      ))}
      <div className="approval-actions">
        <button type="button" className="btn primary" disabled={!complete} onClick={() => api().answer(request.id, answers)}>Send answers</button>
        <button type="button" className="btn" onClick={() => api().answer(request.id, request.questions.map(() => 'You decide (use a sensible default and tell me what you chose).'))}>You decide</button>
      </div>
    </div>
  );
}

const STEP_ICON = { completed: 'check', in_progress: 'play', pending: 'chevron' } as const;

/** The agent's plan as a checklist above the thread; collapsible, with progress. */
export function PlanPanel({ plan }: { plan: Plan }): ReactElement {
  const [open, setOpen] = useState(true);
  const done = plan.steps.filter((step) => step.status === 'completed').length;
  return (
    <div className="plan">
      <button type="button" className="plan-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="plan-title">Plan</span>
        <span className="plan-goal">{plan.goal}</span>
        <span className="plan-count">{done}/{plan.steps.length}</span>
        <Icon name="chevron" size={14} className={`tool-chevron ${open ? 'open' : ''}`} />
      </button>
      <div className="plan-bar"><span style={{ width: `${(done / Math.max(1, plan.steps.length)) * 100}%` }} /></div>
      {open && (
        <ol className="plan-steps">
          {plan.steps.map((step, index) => (
            <li key={`${index}-${step.title}`} className={`plan-step ${step.status}`}>
              <span className="plan-mark">{step.status === 'in_progress' ? <span className="spinner" /> : <Icon name={STEP_ICON[step.status]} size={13} />}</span>
              <span>{step.title}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
