import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactElement } from 'react';
import type { ApprovalPolicy, Attachment, AttachmentResult, Mode, SkillInfo } from '../../shared/types';
import { api } from '../state';
import { Icon } from './Icon';

const PLACEHOLDER: Record<Mode, string> = {
  chat: 'Message Maitre…',
  work: 'Describe a task: build, fix, set up, search, run…',
};

const formatSize = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const KIND_LABEL: Record<Attachment['kind'], string> = { pdf: 'PDF', docx: 'Word', text: 'Text', image: 'Image' };
const KIND_BADGE: Record<Attachment['kind'], string> = { pdf: 'PDF', docx: 'DOC', text: 'TXT', image: 'IMG' };

export function describeAttachment(file: Attachment): string {
  return [`${KIND_LABEL[file.kind]}${file.kind === 'pdf' && file.pages ? ` · ${file.pages} pages` : ''}`, formatSize(file.size)].join(' · ');
}

/** The file's badge, or a thumbnail for an image. */
export function AttachmentIcon({ file }: { file: Attachment }): ReactElement {
  if (file.kind === 'image' && file.dataUrl) return <img className="attachment-thumb" src={file.dataUrl} alt="" />;
  return <span className="attachment-icon">{KIND_BADGE[file.kind]}</span>;
}

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'));
    reader.readAsDataURL(file);
  });

const shortPath = (dir: string): string => dir.replace(/^\/Users\/[^/]+|^C:\\Users\\[^\\]+/i, '~');

const MENU_SIZE = 8;

/** Approval modes in the order Shift+Tab cycles through them, from most careful to fully automatic. */
export const POLICY_MODES: { value: ApprovalPolicy; label: string; icon: 'shield' | 'edit' | 'spark'; text: string; hint: string }[] = [
  { value: 'writes', label: 'Ask before changes', icon: 'shield', text: 'Reads and searches on its own. Every file change and command asks you first.', hint: 'Every change asks you first.' },
  { value: 'risky', label: 'Auto-edit', icon: 'edit', text: 'Edits files and runs safe commands on its own. Deleting, pushing, installs and anything outside the folder ask first.', hint: 'Risky actions ask you first.' },
  { value: 'never', label: 'Full auto', icon: 'spark', text: 'Never asks. Use it only for tasks you trust completely.', hint: 'Maitre acts without asking.' },
];

const policyMode = (policy: ApprovalPolicy) => POLICY_MODES.find((entry) => entry.value === policy) ?? POLICY_MODES[1];

function PolicyPicker({ policy, onPolicy }: { policy: ApprovalPolicy; onPolicy(policy: ApprovalPolicy): void }): ReactElement {
  const [open, setOpen] = useState(false);
  const current = policyMode(policy);
  return (
    <div className="policy-picker">
      <button type="button" className={`policy-pill ${policy}`} onClick={() => setOpen((value) => !value)} aria-haspopup="listbox" aria-expanded={open}
              title={`${current.text}\nShift+Tab switches mode`}>
        <Icon name={current.icon} size={13} /> {current.label} <Icon name="chevron" size={12} />
      </button>
      {open && (
        <div className="policy-menu" role="listbox" aria-label="Approval mode" onMouseLeave={() => setOpen(false)}>
          {POLICY_MODES.map((entry) => (
            <button key={entry.value} type="button" role="option" aria-selected={entry.value === policy} className={entry.value === policy ? 'on' : ''}
                    onClick={() => { onPolicy(entry.value); setOpen(false); }}>
              <Icon name={entry.icon} size={15} />
              <span><b>{entry.label}</b><small>{entry.text}</small></span>
              {entry.value === policy && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Skills matching what follows the `/`: names that start with it first, then names or descriptions that contain it. */
function matchSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  const q = query.toLowerCase();
  const starts = skills.filter((skill) => skill.name.startsWith(q) || skill.name.split(':').pop()!.startsWith(q));
  const contains = skills.filter((skill) => !starts.includes(skill) && `${skill.name} ${skill.description}`.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, MENU_SIZE);
}

function SlashMenu({ items, active, onPick, onHover, onManage }: { items: SkillInfo[]; active: number; onPick(skill: SkillInfo): void; onHover(index: number): void; onManage(): void }): ReactElement {
  return (
    <div className="slash-menu" role="listbox" aria-label="Skills">
      {items.map((skill, index) => (
        <button key={skill.id} type="button" role="option" aria-selected={index === active} className={index === active ? 'on' : ''}
                onMouseDown={(event) => { event.preventDefault(); onPick(skill); }} onMouseEnter={() => onHover(index)}>
          <Icon name={skill.kind === 'command' ? 'slash' : 'book'} size={14} />
          <span className="slash-name">/{skill.name}{skill.argumentHint && <small> {skill.argumentHint}</small>}</span>
          <span className="slash-desc">{skill.description}</span>
        </button>
      ))}
      {!items.length && <div className="slash-empty">No skill with that name.</div>}
      <button type="button" className="slash-manage" onMouseDown={(event) => { event.preventDefault(); onManage(); }}>Manage skills…</button>
    </div>
  );
}

export function Composer({ mode, running, disabled, onSend, onStop, seed, dropped, folder, onChooseFolder, onClearFolder, skills, onManageSkills, policy, onPolicy }: {
  mode: Mode;
  /** When Maitre asks before acting; switched here or with Shift+Tab. */
  policy: ApprovalPolicy;
  onPolicy(policy: ApprovalPolicy): void;
  /** Skills and commands offered after `/`. */
  skills: SkillInfo[];
  onManageSkills(): void;
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
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const slashQuery = /^\/([\w:.-]*)$/.exec(text)?.[1];
  const menu = useMemo(() => (slashQuery === undefined ? null : matchSkills(skills, slashQuery)), [skills, slashQuery]);
  const menuOpen = menu !== null && !menuClosed;
  const invoked = useMemo(() => {
    const name = /^\/([\w:.-]+)\s/.exec(text)?.[1]?.toLowerCase();
    return name ? skills.find((skill) => skill.name === name || skill.name.endsWith(`:${name}`)) : undefined;
  }, [skills, text]);

  const pick = (skill: SkillInfo): void => {
    setText(`/${skill.name} `);
    setMenuIndex(0);
    area.current?.focus();
  };

  const attach = async (paths: string[], images: File[] = []): Promise<void> => {
    setReading(true);
    try {
      const pasted = await Promise.all(images.map(async (image) => api().attachImage(image.name || 'pasted-image.png', await readAsDataUrl(image))));
      const results: AttachmentResult[] = [...(paths.length || !images.length ? await api().attachFiles(paths) : []), ...pasted];
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

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pastedFiles = [...event.clipboardData.files];
    if (!pastedFiles.length) return;
    event.preventDefault();
    const withPath = pastedFiles.map((file) => ({ file, path: api().pathForFile(file) }));
    const paths = withPath.filter((entry) => entry.path).map((entry) => entry.path);
    const images = withPath.filter((entry) => !entry.path && entry.file.type.startsWith('image/')).map((entry) => entry.file);
    if (paths.length || images.length) attach(paths, images);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen && menu.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setMenuIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        pick(menu[Math.min(menuIndex, menu.length - 1)]);
        return;
      }
    }
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      const index = POLICY_MODES.findIndex((entry) => entry.value === policy);
      onPolicy(POLICY_MODES[(index + 1) % POLICY_MODES.length].value);
      return;
    }
    if (menuOpen && event.key === 'Escape') {
      event.preventDefault();
      setMenuClosed(true);
      return;
    }
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
              <AttachmentIcon file={file} />
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
      {invoked && (
        <div className="attachments">
          <div className="skill-chip live" title={invoked.description}><Icon name="book" size={13} /> Using skill <b>{invoked.name}</b>{invoked.argumentHint && <small>{invoked.argumentHint}</small>}</div>
        </div>
      )}
      <div className={`composer ${mode}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        {menuOpen && <SlashMenu items={menu} active={Math.min(menuIndex, Math.max(0, menu.length - 1))} onPick={pick} onHover={setMenuIndex} onManage={onManageSkills} />}
        <button type="button" className="attach" onClick={() => attach([])} aria-label="Attach files" title="Attach images, PDF, Word or text files" disabled={running}>
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
          onChange={(event) => {
            setText(event.target.value);
            setMenuClosed(false);
            setMenuIndex(0);
          }}
          onKeyDown={onKey}
          onPaste={onPaste}
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
      <div className="composer-foot">
        <PolicyPicker policy={policy} onPolicy={onPolicy} />
        <div className="composer-hint">
          {mode === 'work' ? `Work mode can change files and run programs on this computer. ${policyMode(policy).hint}` : 'Maitre can make mistakes. Check important information.'} Drop or paste images, PDF, Word or text files here. Type / for skills.
        </div>
      </div>
    </div>
  );
}
