import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { SkillDraft, SkillInfo, SkillSource } from '../../../shared/types';
import { Empty, ErrorNote, Toggle, useAction, useLive } from './shared';
import { Icon } from '../Icon';
import { api } from '../../state';

const GROUPS: { source: SkillSource; title: string; note: string }[] = [
  { source: 'user', title: 'Your skills', note: 'Saved in ~/.maitre/skills. Edit them here or in any text editor.' },
  { source: 'project', title: 'This project', note: 'From .maitre/skills or .claude/skills in the working folder.' },
  { source: 'plugin', title: 'From plugins', note: 'Come and go with their plugin.' },
  { source: 'claude', title: 'From Claude Code', note: 'Your ~/.claude/skills, shared with Claude Code.' },
  { source: 'builtin', title: 'Built in', note: 'Ship with Maitre. "Customize" saves your own copy that replaces it.' },
];

const DESCRIPTION_MAX = 1024;
const EMPTY_DRAFT: SkillDraft = { name: '', description: '', instructions: '' };

const TEMPLATE = `# Goal
What this skill produces, for whom, in what format.

## Steps
1. …
2. …

## Output format
…

## Avoid
- …`;

function SkillEditor({ initial, replaceId, onDone }: { initial: SkillDraft; replaceId?: string; onDone(): void }): ReactElement {
  const [draft, setDraft] = useState<SkillDraft>(initial);
  const { busy, error, run } = useAction();
  const set = (patch: Partial<SkillDraft>): void => setDraft((current) => ({ ...current, ...patch }));
  const save = async (): Promise<void> => {
    if (await run('save', () => api().saveSkill(draft, replaceId))) onDone();
  };
  return (
    <div className="editor" role="form" aria-label="Skill editor">
      <div className="grid2">
        <label>
          Name
          <input value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="weekly-report" spellCheck={false} autoFocus />
          <span className="field-hint">Lowercase words with hyphens. You will run it as /{draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'name'}</span>
        </label>
        <label>
          When should Maitre use it?
          <textarea className="short" value={draft.description} maxLength={DESCRIPTION_MAX} onChange={(event) => set({ description: event.target.value })}
                    placeholder="Writes the weekly client report from my notes. Use when I ask for the weekly report or a client status update." />
          <span className="field-hint">{draft.description.length}/{DESCRIPTION_MAX}. Say what it does and the words that should trigger it.</span>
        </label>
      </div>
      <label>
        Instructions (Markdown)
        <textarea className="code-area" value={draft.instructions} onChange={(event) => set({ instructions: event.target.value })} placeholder={TEMPLATE} spellCheck={false} />
      </label>
      <ErrorNote error={error} />
      <div className="connector-actions">
        <button type="button" className="btn primary small" disabled={busy !== null} onClick={save}>{busy ? 'Saving…' : 'Save skill'}</button>
        <button type="button" className="btn small" onClick={onDone}>Cancel</button>
        {!draft.instructions && <button type="button" className="link" onClick={() => set({ instructions: TEMPLATE })}>Start from a template</button>}
      </div>
    </div>
  );
}

function SkillRow({ skill, onEdit }: { skill: SkillInfo; onEdit(skill: SkillInfo, copy: boolean): void }): ReactElement {
  const [open, setOpen] = useState(false);
  const { error, run } = useAction();
  const invoke = skill.userInvocable ? `/${skill.name}${skill.argumentHint ? ` ${skill.argumentHint}` : ''}` : null;
  return (
    <div className={`item ${skill.enabled ? '' : 'off'}`}>
      <div className="item-head">
        <button type="button" className="item-main" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="item-icon"><Icon name={skill.kind === 'command' ? 'slash' : 'book'} size={15} /></span>
          <span className="item-text">
            <span className="item-title">{skill.name}{skill.kind === 'command' && <span className="tag">command</span>}{!skill.modelInvocable && skill.kind === 'skill' && <span className="tag">only with /</span>}</span>
            <span className="item-sub">{skill.description}</span>
          </span>
        </button>
        <Toggle checked={skill.enabled} label={`${skill.enabled ? 'Turn off' : 'Turn on'} ${skill.name}`} onChange={(next) => run('toggle', () => api().setSkillEnabled(skill.id, next))} />
      </div>
      {open && (
        <div className="item-body">
          {invoke && <div className="field-note">Run it yourself: <code>{invoke}</code></div>}
          {skill.files.length > 0 && <div className="field-note">Files: {skill.files.slice(0, 12).join(', ')}{skill.files.length > 12 ? ', …' : ''}</div>}
          <div className="connector-actions">
            {skill.editable && <button type="button" className="btn small" onClick={() => onEdit(skill, false)}>Edit</button>}
            {!skill.editable && skill.kind === 'skill' && <button type="button" className="btn small" onClick={() => onEdit(skill, true)}>Customize</button>}
            {skill.dir && <button type="button" className="btn small" onClick={() => api().revealPath(skill.dir!)}>Show in folder</button>}
            {skill.source === 'user' && <button type="button" className="btn small danger" onClick={() => run('delete', () => api().deleteSkill(skill.id))}>Delete</button>}
          </div>
          <ErrorNote error={error} />
        </div>
      )}
    </div>
  );
}

export function SkillsTab({ cwd, onBrowse }: { cwd?: string; onBrowse(): void }): ReactElement {
  const [skills] = useLive(() => api().listSkills(cwd), ['skills', 'plugins'], [] as SkillInfo[]);
  const [editing, setEditing] = useState<{ draft: SkillDraft; replaceId?: string } | null>(null);
  const [query, setQuery] = useState('');
  const { busy, error, run } = useAction();
  const [imported, setImported] = useState('');

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return skills.filter((skill) => words.every((word) => `${skill.name} ${skill.description}`.toLowerCase().includes(word)));
  }, [skills, query]);

  const edit = async (skill: SkillInfo, copy: boolean): Promise<void> => {
    const document = await api().getSkill(skill.id);
    if (!document) return;
    const name = copy ? document.name.replace(/^.*:/, '') : document.name;
    setEditing({ draft: { name, description: document.description, instructions: document.instructions }, replaceId: skill.id });
  };

  const importFolder = (): Promise<boolean> => run('import', async () => {
    const added = await api().importSkillFolder();
    setImported(added.length ? `Added ${added.map((skill) => skill.name).join(', ')}.` : '');
  });

  if (editing) {
    return (
      <div className="tab-body">
        <div className="tab-intro"><h3>{editing.replaceId ? 'Edit skill' : 'New skill'}</h3></div>
        <SkillEditor initial={editing.draft} replaceId={editing.replaceId} onDone={() => setEditing(null)} />
      </div>
    );
  }

  return (
    <div className="tab-body">
      <div className="tab-intro">
        <p>Skills teach Maitre how you want a kind of task done: a report format, a review checklist, a workflow with scripts. Maitre picks the right skill on its own, or you type <code>/</code> in the message box to run one.</p>
        <div className="connector-actions">
          <button type="button" className="btn primary small" onClick={() => setEditing({ draft: EMPTY_DRAFT })}><Icon name="plus" size={14} /> New skill</button>
          <button type="button" className="btn small" disabled={busy !== null} onClick={importFolder}>{busy === 'import' ? 'Importing…' : 'Import folder…'}</button>
          <button type="button" className="btn small" onClick={onBrowse}><Icon name="download" size={14} /> Get skills from GitHub</button>
          <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" aria-label="Search skills" />
        </div>
        <div className="field-note">Tip: ask Maitre "make a skill for …" and it writes one with you (skill-creator).</div>
        {imported && <div className="field-note ok">{imported}</div>}
        <ErrorNote error={error} />
      </div>
      {GROUPS.map((group) => {
        const items = filtered.filter((skill) => skill.source === group.source);
        if (!items.length && group.source !== 'user') return null;
        return (
          <section key={group.source} className="group">
            <div className="group-head"><h4>{group.title}</h4><span>{group.note}</span></div>
            {items.length ? items.map((skill) => <SkillRow key={skill.id} skill={skill} onEdit={edit} />) : <Empty>{query ? 'No matching skills.' : 'No skills of your own yet. Create one, import a folder, or ask Maitre to write one.'}</Empty>}
          </section>
        );
      })}
    </div>
  );
}
