/**
 * Maitre: the Chat | Work switch at the top of the sidebar, above New Session.
 *
 * A session keeps the mode it started with, so switching on a blank session
 * restages it, and switching while a conversation is open starts a new
 * session in the chosen mode.
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { AgentPresetSeatState } from './seat-store.ts'
import css from './ModeSwitch.module.css'

/** Preset id behind the sidebar's Chat segment; every other preset counts as Work. */
export const MAITRE_CHAT_PRESET = 'chat'

/** Work preset used until the person picks another one from the input chip. */
const DEFAULT_WORK_PRESET = 'standard'

type Mode = 'chat' | 'work'

const MODES: readonly { value: Mode; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'work', label: 'Work' },
]

/** Minimal session-list face the switch reads. */
export interface ModeSessionList {
  byId: Record<string, {
    blank?: boolean
    retainedBy: { mainView?: number }
    projectionValues?: Record<string, unknown>
  }>
}

/** Registration-side face for the sidebar switch. */
export interface ModeSwitchInjected {
  hooks: {
    modeSessions: ObservableSnapshot<ModeSessionList>
    modeSeat: SnapshotStore<AgentPresetSeatState>
  }
  load: () => Promise<void>
  pick: (id: string, mainIsBlank: boolean) => void
}

/** Full component props. */
export type ModeSwitchProps =
  PropsRuntime<'sidebar.session.action'>
  & InjectFace<ModeSwitchInjected>
  & { children: ReactNode }

/**
 * Render the sidebar mode switch above the New Session row.
 * @param props - composed slot props.
 * @returns the switch followed by the shell's New Session content.
 */
export function ModeSwitch({ wide, children, useModeSessions, useModeSeat, load, pick }: ModeSwitchProps) {
  const main = useModeSessions((list) => {
    const session = Object.values(list.byId).find(entry => (entry.retainedBy.mainView ?? 0) > 0)
    if (session === undefined) return ''
    const preset = session.projectionValues?.agentPreset
    return `${session.blank === true ? 'b' : 's'}:${typeof preset === 'string' ? preset : ''}`
  })
  const staged = useModeSeat(state => state.current)
  const options = useModeSeat(state => state.options)

  const lastWork = useRef(DEFAULT_WORK_PRESET)

  useEffect(() => { void load() }, [load])

  if (!wide || options.length < 2) return <>{children}</>

  const mainIsBlank = main === '' || main.startsWith('b:')
  const current = main.slice(2) || staged
  if (current !== '' && current !== MAITRE_CHAT_PRESET) lastWork.current = current
  const value: Mode = current === MAITRE_CHAT_PRESET ? 'chat' : 'work'
  return (
    <div className={css.stack}>
      <div className={css.row}>
        <SegmentedControl
          id="maitre-mode"
          className={css.control}
          value={value}
          label="Mode"
          options={MODES}
          onChange={(next) => { pick(next === 'chat' ? MAITRE_CHAT_PRESET : lastWork.current, mainIsBlank) }}
        />
      </div>
      <div className={css.actions}>{children}</div>
    </div>
  )
}
