import crypto from 'node:crypto';
import type { AgentEvent, QuestionRequest } from '../../shared/types';

interface Pending {
  request: QuestionRequest;
  resolve: (answers: string[] | null) => void;
}

/** Questions the agent asks the user mid-task (ask_user); the run waits until the user answers or stops it. */
export class Questions {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  ask(input: Omit<QuestionRequest, 'id'>, signal: AbortSignal): Promise<string[] | null> {
    const request: QuestionRequest = { ...input, id: crypto.randomUUID() };
    return new Promise((resolve) => {
      const finish = (answers: string[] | null): void => {
        if (!this.pending.delete(request.id)) return;
        signal.removeEventListener('abort', onAbort);
        this.emit({ type: 'question-resolved', id: request.id });
        resolve(answers);
      };
      const onAbort = (): void => finish(null);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(request.id, { request, resolve: finish });
      this.emit({ type: 'question', request });
    });
  }

  answer(id: string, answers: string[]): void {
    this.pending.get(id)?.resolve(answers.map((answer) => String(answer).slice(0, 4000)));
  }

  open(): QuestionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }
}
