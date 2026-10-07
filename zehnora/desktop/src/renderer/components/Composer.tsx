import { useEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, ReactElement } from 'react';
import type { Attachment, AttachmentResult, Mode } from '../../shared/types';
import { api } from '../state';
import { Icon } from './Icon';

const PLACEHOLDER: Record<Mode, string> = {
  chat: 'Message Maitre…',
  work: 'Describe a task: build, fix, set up, search, run…',
};

const formatSize = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export function describeAttachment(file: Attachment): string {
  return [file.kind === 'pdf' ? `PDF${file.pages ? ` · ${file.pages} pages` : ''}` : file.kind === 'docx' ? 'Word' : 'Text', formatSize(file.size)].join(' · ');
}

const shortPath = (dir: string): string => dir.replace(/^\/Users\/[^/]+|^C:\\Users\\[^\\]+/i, '~');

export function Composer({ mode, running, disabled, onSend, onStop, seed, dropped, folder, onChooseFolder, onClearFolder }: {
  mode: Mode;
  /** Work mode: the task's working folder and whether the user picked it. */
  folder?: { path: string; chosen: boolean };
  onChooseFolder?(): void;
  onClearFolder?(): void;
  running: boolean;
  disabled: boolean;
  dropped: { paths: string[]; nonce: number } | null;
  onSend(text: string, attachments: Attachment[]): void;
  onStop(): void;
  seed: { text: string; nonce: number } | null;
}): ReactElement {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const attach = async (paths: string[]): Promise<void> => {
    setReading(true);
    try {
      const results: AttachmentResult[] = await api().attachFiles(paths);
      setFiles((current) => [...current, ...results.filter((r): r is Attachment => !('error' in r))]);
      setErrors(results.filter((r): r is { name: string; error: string } => 'error' in r).map((r) => `${r.name}: ${r.error}`));
    } finally {
      setReading(false);
      area.current?.focus();
    }
  };

  useEffect(() => {
    if (dropped?.paths.length) attach(dropped.paths);
  }, [dropped]);

  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    area.current?.focus();
  }, [seed]);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
  }, [text]);

  useEffect(() => {
    area.current?.focus();
  }, [mode]);

  const submit = (): void => {
    const value = text.trim();
    if ((!value && !files.length) || running || disabled || reading) return;
    onSend(value, files);
    setText('');
    setFiles([]);
    setErrors([]);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const paths = [...event.dataTransfer.files].map((file) => api().pathForFile(file)).filter(Boolean);
    if (paths.length) attach(paths);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-wrap">
      {(files.length > 0 || errors.length > 0 || reading || (mode === 'work' && folder?.chosen)) && (
        <div className="attachments">
          {mode === 'work' && folder?.chosen && (
            <div className="attachment folder" title={folder.path}>
              <span className="attachment-icon folder-icon"><Icon name="folder" size={16} /></span>
              <span className="attachment-text"><b>{folder.path.split(/[\\/]/).filter(Boolean).pop() ?? folder.path}</b><small>Working folder · {shortPath(folder.path)}</small></span>
              <button type="button" className="attachment-remove" aria-label="Use the default folder" onClick={onClearFolder}>
                <Icon name="x" size={13} />
              </button>
            </div>
          )}
          {files.map((file) => (
            <div key={file.id} className="attachment" title={file.path}>
              <span className="attachment-icon">{file.kind === 'pdf' ? 'PDF' : file.kind === 'docx' ? 'DOC' : 'TXT'}</span>
              <span className="attachment-text"><b>{file.name}</b><small>{describeAttachment(file)}</small></span>
              <button type="button" className="attachment-remove" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((f) => f.id !== file.id))}>
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
          {reading && <div className="attachment reading"><span className="spinner" /> Reading file…</div>}
          {errors.map((error) => <div key={error} className="attachment-error" role="alert">{error}</div>)}
        </div>
      )}
      <div className={`composer ${mode}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <button type="button" className="attach" onClick={() => attach([])} aria-label="Attach files" title="Attach PDF, Word or text files" disabled={running}>
          <Icon name="clip" size={18} />
        </button>
        {mode === 'work' && (
          <button type="button" className={`attach ${folder?.chosen ? 'on' : ''}`} onClick={onChooseFolder} aria-label="Choose working folder"
                  title={folder ? `Working folder: ${folder.path}\nClick to choose another folder` : 'Choose the folder to work in'}>
            <Icon name="folder" size={18} />
          </button>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={PLACEHOLDER[mode]}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKey}
          aria-label="Message"
        />
        {running ? (
          <button type="button" className="send stop" onClick={onStop} aria-label="Stop">
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button type="button" className="send" onClick={submit} disabled={(!text.trim() && !files.length) || disabled || reading} aria-label="Send">
            <Icon name="send" size={17} />
          </button>
        )}
      </div>
      <div className="composer-hint">
        {mode === 'work' ? 'Work mode can change files and run programs on this computer. Risky actions ask you first.' : 'Maitre can make mistakes. Check important information.'} Drop PDF, Word or text files here.
      </div>
    </div>
  );
}
