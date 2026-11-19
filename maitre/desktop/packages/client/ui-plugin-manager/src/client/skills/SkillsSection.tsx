/** The Plugins page's list of skills installed from GitHub, each with where it came from and a two-step Remove. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InstalledSkill } from '../../skills/types.ts'
import type { Translate } from '../presentation.ts'
import pageCss from '../PluginManagerPage.module.css'
import css from './Skills.module.css'

const sourceLabel = (skill: InstalledSkill): string =>
  `${skill.source.repo}${skill.source.path === undefined ? '' : `/${skill.source.path}`}${skill.source.commit === undefined ? '' : ` @ ${skill.source.commit.slice(0, 7)}`}`

/**
 * Render the section once at least one skill was installed from GitHub.
 * @param props.skills - the ledger's skills.
 * @param props.removing - the skill being removed.
 * @param props.t - the page's translator.
 * @param props.onEnsure - read the list when the section first renders.
 * @param props.onRemove - delete a skill.
 * @returns the section, or nothing while the list is empty.
 */
export function SkillsSection({ skills, removing, t, onEnsure, onRemove }: {
  readonly skills: readonly InstalledSkill[]
  readonly removing: string | null
  readonly t: Translate
  readonly onEnsure: () => void
  readonly onRemove: (name: string) => void
}): ReactNode {
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => { onEnsure() }, [onEnsure])
  if (skills.length === 0) return null
  return (
    <section className={pageCss.group} data-plugin-scope="global" data-plugin-group="skills" aria-label={t('skillSectionTitle')}>
      <div className={pageCss.groupHead}>
        <h3 className={pageCss.groupTitle}>{t('skillSectionTitle')}</h3>
      </div>
      <p className={css.hint}>{t('skillSectionHint')}</p>
      <ul className={css.installed}>
        {skills.map(skill => (
          <li key={skill.name} className={css.installedRow} data-skill={skill.name}>
            <span className={css.installedText}>
              <span className={css.rowName}>
                {skill.name}
                {skill.present ? null : <Tag tone="outline">{t('skillMissing')}</Tag>}
              </span>
              {skill.description === '' ? null : <span className={css.rowDescription}>{skill.description}</span>}
              <span className={css.installedSource}>
                <a href={skill.source.url} target="_blank" rel="noreferrer noopener">{t('skillFrom', { repo: sourceLabel(skill) })}</a>
              </span>
            </span>
            <Button variant="outline" size="sm" disabled={removing !== null} aria-busy={removing === skill.name}
              aria-label={`${t(armed === skill.name ? 'skillRemoveConfirm' : 'skillRemove')} ${skill.name}`}
              onBlur={() => { if (armed === skill.name) setArmed(null) }}
              onClick={() => {
                if (armed !== skill.name) {
                  setArmed(skill.name)
                  return
                }
                setArmed(null)
                onRemove(skill.name)
              }}>
              {removing === skill.name ? <StateDot state="ongoing" /> : null}
              {t(removing === skill.name ? 'skillRemoving' : armed === skill.name ? 'skillRemoveConfirm' : 'skillRemove')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
