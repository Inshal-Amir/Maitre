/**
 * The review a GitHub skills repository opens from the Add plugin dialog: the
 * skills it holds with checkboxes, a filter, select all and none, a note that
 * skills are instructions the model follows, a replace-or-keep step for names
 * already installed, and the outcome of the copy.
 */
import { useMemo, useState, type ReactNode } from 'react'
import {
  Button, IconSearchOutlineRegular, IconWarningOutlineRegular, Input, Modal, StateDot, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillCandidate } from '../../skills/types.ts'
import type { Translate } from '../presentation.ts'
import type { SkillReview } from './store.ts'
import css from './Skills.module.css'

/** The first line of a discovery problem; YAML errors carry a code frame after it. */
const firstLine = (text: string): string => (text.split('\n')[0] ?? text).replace('YAMLParseError: ', '').replace(/:$/, '')

function matches(skill: SkillCandidate, filter: string): boolean {
  if (filter === '') return true
  return skill.name.toLowerCase().includes(filter) || skill.description.toLowerCase().includes(filter)
}

function SkillRow({ skill, checked, onToggle, t }: {
  readonly skill: SkillCandidate
  readonly checked: boolean
  readonly onToggle: (next: boolean) => void
  readonly t: Translate
}): ReactNode {
  const invalid = skill.problem !== undefined
  return (
    <li>
      <label className={css.row} data-invalid={invalid || undefined}>
        <input type="checkbox" checked={checked && !invalid} disabled={invalid} aria-label={skill.name}
          onChange={(event) => { onToggle(event.currentTarget.checked) }} />
        <span className={css.rowText}>
          <span className={css.rowName}>
            {skill.name}
            {skill.exists ? <Tag tone="outline">{t('skillExists')}</Tag> : null}
          </span>
          {skill.description === '' ? null : <span className={css.rowDescription}>{skill.description}</span>}
          {invalid ? <span className={css.rowProblem}>{t('skillInvalid', { reason: firstLine(skill.problem ?? '') })}</span> : null}
        </span>
      </label>
    </li>
  )
}

function ResultBody({ review, t }: { readonly review: SkillReview; readonly t: Translate }): ReactNode {
  const result = review.result
  if (result === undefined) return null
  if (!result.ok) return <p className={css.error} role="alert">{result.message}</p>
  const reasons = { exists: t('skillReasonExists'), invalid: t('skillReasonInvalid'), unknown: t('skillReasonInvalid') }
  const skipped = result.skipped.map(item => `${item.name} (${reasons[item.reason]})`).join(', ')
  return (
    <div className={css.body}>
      <p className={css.message} role="status">
        {result.installed.length > 0 ? t('skillDoneInstalled', { names: result.installed.join(', ') }) : t('skillDoneNone')}
      </p>
      {skipped === '' ? null : <p className={css.message}>{t('skillDoneSkipped', { names: skipped })}</p>}
      {result.warnings.length === 0 ? null : <p className={css.message}>{t('skillDoneWarnings', { warnings: result.warnings.join('; ') })}</p>}
    </div>
  )
}

/**
 * Render the review while one is open.
 * @param props.review - the staged repository and its skills.
 * @param props.t - the page's translator.
 * @param props.onClose - leave the review.
 * @param props.onInstall - copy the chosen folders, replacing the named existing skills.
 * @returns the dialog.
 */
export function SkillReviewDialog({ review, t, onClose, onInstall }: {
  readonly review: SkillReview
  readonly t: Translate
  readonly onClose: () => void
  readonly onInstall: (ids: readonly string[], replace: readonly string[]) => void
}): ReactNode {
  const valid = useMemo(() => review.skills.filter(skill => skill.problem === undefined), [review.skills])
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(valid.map(skill => skill.id)))
  const [filter, setFilter] = useState('')
  const [confirming, setConfirming] = useState(false)
  const needle = filter.trim().toLowerCase()
  const shown = review.skills.filter(skill => matches(skill, needle))
  const chosen = valid.filter(skill => selected.has(skill.id))
  const conflicts = chosen.filter(skill => skill.exists)
  const installing = review.phase === 'installing'
  const setMany = (skills: readonly SkillCandidate[], on: boolean): void => {
    const next = new Set(selected)
    for (const skill of skills) {
      if (skill.problem !== undefined) continue
      if (on) next.add(skill.id)
      else next.delete(skill.id)
    }
    setSelected(next)
  }
  const install = (replace: boolean): void => {
    onInstall(chosen.map(skill => skill.id), replace ? conflicts.map(skill => skill.name) : [])
  }

  if (review.phase === 'done') {
    const failed = review.result?.ok === false
    return (
      <Modal open onClose={onClose} title={t(failed ? 'skillFailedTitle' : 'skillDoneTitle')} closeLabel={t('close')}
        className={css.dialog as string}
        footer={<div className={css.footer}><Button variant="primary" autoFocus onClick={onClose}>{t('close')}</Button></div>}>
        <ResultBody review={review} t={t} />
      </Modal>
    )
  }

  if (confirming && conflicts.length > 0) {
    return (
      <Modal open onClose={onClose} title={t('skillConflictTitle')} closeLabel={t('close')} className={css.dialog as string}
        description={t('skillConflictDescription', { names: conflicts.map(skill => skill.name).join(', ') })}
        footer={(
          <div className={css.footer}>
            <Button variant="outline" disabled={installing} onClick={() => { setConfirming(false) }}>{t('skillBack')}</Button>
            <Button variant="outline" disabled={installing} onClick={() => { install(false) }}>{t('skillKeep')}</Button>
            <Button variant="primary" disabled={installing} aria-busy={installing} onClick={() => { install(true) }}>
              {installing ? <StateDot state="ongoing" /> : null}
              {t(installing ? 'skillInstalling' : 'skillReplace')}
            </Button>
          </div>
        )}
      />
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('skillReviewTitle')}
      closeLabel={t('close')}
      description={t('skillReviewDescription', { repo: review.source.path === undefined ? review.source.repo : `${review.source.repo}/${review.source.path}`, count: String(review.skills.length) })}
      className={css.dialog as string}
      contentClassName={css.content as string}
      footer={(
        <div className={css.footer}>
          <Button variant="outline" disabled={installing} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={installing || chosen.length === 0} aria-busy={installing}
            onClick={() => { if (conflicts.length > 0) setConfirming(true); else install(false) }}>
            {installing ? <StateDot state="ongoing" /> : null}
            {t(installing ? 'skillInstalling' : 'skillInstall', { count: String(chosen.length) })}
          </Button>
        </div>
      )}
    >
      <div className={css.body}>
        <p className={css.note} role="note">
          <IconWarningOutlineRegular size={14} aria-hidden="true" />
          <span>{t('skillReviewNote')}</span>
        </p>
        <div className={css.toolbar}>
          <Input className={css.search as string} icon={<IconSearchOutlineRegular size={14} />} value={filter} data-modal-autofocus
            placeholder={t('skillSearch')} aria-label={t('skillSearch')} onChange={(event) => { setFilter(event.currentTarget.value) }} />
          <Button variant="ghost" size="sm" disabled={installing} onClick={() => { setMany(shown, true) }}>{t('skillSelectAll')}</Button>
          <Button variant="ghost" size="sm" disabled={installing} onClick={() => { setMany(shown, false) }}>{t('skillSelectNone')}</Button>
          <span className={css.count} aria-live="polite">{t('skillSelected', { count: String(chosen.length) })}</span>
        </div>
        <ul className={css.list} aria-label={t('skillReviewTitle')}>
          {shown.map(skill => (
            <SkillRow key={skill.id} skill={skill} t={t} checked={selected.has(skill.id)}
              onToggle={(next) => { setMany([skill], next) }} />
          ))}
          {shown.length === 0 ? <li className={css.message}>{t('skillNoMatch')}</li> : null}
        </ul>
      </div>
    </Modal>
  )
}
