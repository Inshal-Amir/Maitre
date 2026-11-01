import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { AgentEvent } from '../../../shared/types';
import { api } from '../../state';

/** IPC errors arrive as "Error invoking remote method 'x': Error: message"; keep the message. */
export const cleanError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');

/** Loads data from the main process and reloads it when one of the given events arrives. */
export function useLive<T>(load: () => Promise<T>, events: AgentEvent['type'][], initial: T): [T, () => Promise<void>] {
  const [value, setValue] = useState<T>(initial);
  const loader = useRef(load);
  loader.current = load;
  const reload = useCallback(async () => {
    setValue(await loader.current());
  }, []);
  const key = events.join(',');
  useEffect(() => {
    reload();
    const wanted = new Set(key.split(','));
    return api().onEvent((event) => {
      if (wanted.has(event.type)) reload();
    });
  }, [reload, key]);
  return [value, reload];
}

/** Runs an async action with a busy flag and a readable error. */
export function useAction(): { busy: string | null; error: string; run(label: string, action: () => Promise<unknown>): Promise<boolean>; clear(): void } {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const run = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError('');
    try {
      await action();
      return true;
    } catch (failure) {
      setError(cleanError(failure));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, run, clear: () => setError('') };
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange(next: boolean): void; label: string; disabled?: boolean }): ReactElement {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Mark({ text, color }: { text: string; color: string }): ReactElement {
  return <span className="mark" style={{ background: color }} aria-hidden="true">{text}</span>;
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <div className="empty-note">{children}</div>;
}

export function ErrorNote({ error }: { error: string }): ReactElement | null {
  return error ? <div className="step-error" role="alert">{error}</div> : null;
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }): ReactElement {
  return (
    <a href={href} onClick={(event) => { event.preventDefault(); api().openExternal(href); }}>{children}</a>
  );
}
