/** The Connectors page: the catalog grouped by category, with search, sign-in, keys, and custom servers. */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, Checkbox, IconPlusOutlineRegular, IconSearchOutlineRegular, Input, Modal, StateDot, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  ConnectOutcome, ConnectorCategory, ConnectorsSnapshot, ConnectorView, ConnectRequest, CustomConnectorRequest, GoogleService,
} from '../types.ts'
import css from './ConnectorsPage.module.css'

/** Page data as the stream delivers it. */
export type ConnectorsPageState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; snapshot: ConnectorsSnapshot }

/** Injected stream and actions. */
export interface ConnectorsInjected {
  readonly hooks: { readonly connectors: HostObservable<ConnectorsPageState> }
  /**
   * Connect one entry.
   * @param request - entry id with its key or Google products.
   * @param signIn - whether a browser sign-in will follow, so a tab opens on this click.
   */
  readonly connect: (request: ConnectRequest, signIn: boolean) => Promise<ConnectOutcome>
  readonly addCustom: (request: CustomConnectorRequest) => Promise<ConnectOutcome>
  readonly disconnect: (id: string) => Promise<void>
  readonly cancel: (id: string) => Promise<void>
}

type Props = PropsRuntime<'main'> & InjectFace<ConnectorsInjected> & PropsLocale<'connectors'>
type T = Props['t']

const CATEGORIES: readonly ConnectorCategory[] = ['google', 'custom', 'work', 'sales', 'finance', 'design', 'developer', 'data', 'search', 'local']
const SERVICES: readonly GoogleService[] = ['gmail', 'calendar', 'drive', 'docs', 'sheets']

function Mark({ connector }: { connector: ConnectorView }): ReactNode {
  return <span className={css.mark} style={{ background: connector.color }} aria-hidden="true">{connector.mark}</span>
}

function StatusLine({ connector, t }: { connector: ConnectorView; t: T }): ReactNode {
  switch (connector.phase) {
    case 'connected':
    case 'builtin':
      return (
        <span className={css.status}>
          <Tag tone="success">{t(connector.phase === 'builtin' ? 'phase.builtin' : 'phase.connected')}</Tag>
          {connector.toolCount !== undefined && <span>{t('tools', { count: connector.toolCount })}</span>}
          {connector.account !== undefined && <span>{t('account', { account: connector.account })}</span>}
        </span>
      )
    case 'authorizing':
      return (
        <span className={css.status}>
          <StateDot state="ongoing" />
          <span>{t('phase.authorizing')}</span>
          {connector.authUrl !== undefined && <a href={connector.authUrl} target="_blank" rel="noreferrer">{t('openSignIn')}</a>}
        </span>
      )
    case 'connecting':
      return <span className={css.status}><StateDot state="ongoing" /><span>{t('phase.connecting')}</span></span>
    case 'error':
      return <span className={css.status}><Tag tone="danger">{t('phase.error')}</Tag></span>
    case 'disconnected':
      return (
        <span className={css.status}>
          {connector.unavailable !== undefined
            ? <Tag tone="neutral">{t('unavailable')}</Tag>
            : <Tag tone="quiet">{t(`auth.${connector.auth}`)}</Tag>}
          {connector.transport === 'stdio' && <Tag tone="quiet">{t('transport.stdio')}</Tag>}
        </span>
      )
  }
}

function ConnectorRow({ connector, props }: { connector: ConnectorView; props: Props }): ReactNode {
  const { t, connect, disconnect, cancel } = props
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [keyOpen, setKeyOpen] = useState(false)
  const [key, setKey] = useState('')
  const [services, setServices] = useState<readonly GoogleService[]>(connector.services ?? SERVICES)
  const granted = connector.services?.join(',')
  useEffect(() => {
    if (connector.services !== undefined) setServices(connector.services)
    // `granted` is the services list's value identity; a new snapshot array with the same products changes nothing.
  }, [granted])
  const run = async (action: () => Promise<ConnectOutcome | void>): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = await action()
      if (outcome !== undefined && outcome.kind === 'failed') setFailure(outcome.message)
      if (outcome !== undefined && outcome.kind !== 'failed') {
        setKeyOpen(false)
        setKey('')
      }
    } finally {
      setBusy(false)
    }
  }
  const signIn = connector.auth === 'oauth' || connector.auth === 'google'
  const start = (): void => {
    if (connector.auth === 'key' && !keyOpen) {
      setKeyOpen(true)
      return
    }
    void run(() => connect({ id: connector.id, ...(connector.auth === 'key' ? { key } : {}), ...(connector.auth === 'google' ? { services: [...services] } : {}) }, signIn))
  }
  const linked = connector.phase === 'connected' || connector.phase === 'connecting' || connector.phase === 'error'
  const canConnect = connector.unavailable === undefined && (connector.phase === 'disconnected' || connector.phase === 'error')
  const error = failure ?? connector.error ?? (connector.phase === 'disconnected' ? connector.unavailable : undefined)
  return (
    <li className={css.row} data-phase={connector.phase}>
      <div className={css.head}>
        <Mark connector={connector} />
        <div className={css.main}>
          <div className={css.titleRow}>
            <span className={css.name}>{connector.name}</span>
            {connector.docs !== '' && <a className={css.docs} href={connector.docs} target="_blank" rel="noreferrer">{t('docs')}</a>}
          </div>
          <div className={css.description}>{connector.description}</div>
          <StatusLine connector={connector} t={t} />
          {error !== undefined && <div className={connector.phase === 'disconnected' && failure === undefined ? css.note : css.error}>{error}</div>}
        </div>
        <div className={css.actions}>
          {connector.phase === 'authorizing' && <Button size="sm" variant="outline" onClick={() => { void cancel(connector.id) }}>{t('cancel')}</Button>}
          {canConnect && (
            <Button size="sm" variant={connector.phase === 'error' ? 'outline' : 'primary'} disabled={busy || (connector.auth === 'google' && services.length === 0)} onClick={start}>
              {t(connector.phase === 'error' ? 'retry' : 'connect')}
            </Button>
          )}
          {(linked || (connector.category === 'custom' && connector.phase !== 'authorizing')) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run(() => disconnect(connector.id)) }}>
              {t(connector.category === 'custom' ? 'remove' : 'disconnect')}
            </Button>
          )}
        </div>
      </div>
      {connector.auth === 'google' && connector.unavailable === undefined && connector.phase !== 'authorizing' && (
        <div className={css.extra} role="group" aria-label={t('google.services')}>
          <div className={css.services}>
            {SERVICES.map(service => (
              <Checkbox key={service} label={t(`service.${service}`)} checked={services.includes(service)}
                onChange={(next) => { setServices(next ? [...services, service] : services.filter(item => item !== service)) }} />
            ))}
          </div>
          {connector.phase === 'connected' && (
            <Button size="sm" variant="outline" disabled={busy || services.length === 0} onClick={() => { void run(async () => { await disconnect('google'); return connect({ id: 'google', services: [...services] }, true) }) }}>
              {t('google.reconnect')}
            </Button>
          )}
        </div>
      )}
      {keyOpen && connector.input !== undefined && canConnect && (
        <form className={css.extra} onSubmit={(event) => { event.preventDefault(); start() }}>
          <label className={css.field}>
            <span>
              {connector.input.label}
              {connector.input.helpUrl !== undefined && <> · <a href={connector.input.helpUrl} target="_blank" rel="noreferrer">{t('getKey')}</a></>}
            </span>
            <Input type={connector.input.secret ? 'password' : 'text'} value={key} placeholder={connector.input.placeholder} autoComplete="off" spellCheck={false}
              onChange={(event) => { setKey(event.target.value) }} />
          </label>
          <div className={css.formActions}>
            <Button size="sm" variant="primary" type="submit" disabled={busy || key.trim() === ''}>{t('save')}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setKeyOpen(false) }}>{t('cancel')}</Button>
          </div>
        </form>
      )}
    </li>
  )
}

function CustomDialog({ props, onClose }: { props: Props; onClose: () => void }): ReactNode {
  const { t, addCustom } = props
  const [draft, setDraft] = useState<CustomConnectorRequest>({ name: '', url: '', headerName: '', headerValue: '' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const submit = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    const outcome = await addCustom(draft)
    setBusy(false)
    if (outcome.kind === 'failed' && outcome.added !== true) setFailure(outcome.message)
    else onClose()
  }
  const field = (key: keyof CustomConnectorRequest, label: string, placeholder: string, secret = false): ReactNode => (
    <label className={css.field}>
      <span>{label}</span>
      <Input type={secret ? 'password' : 'text'} value={draft[key] ?? ''} placeholder={placeholder} autoComplete="off" spellCheck={false}
        data-modal-autofocus={key === 'name' || undefined} onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }) }} />
    </label>
  )
  return (
    <Modal open onClose={onClose} title={t('custom.title')} description={t('custom.description')} closeLabel={t('close')}
      footer={(
        <div className={css.formActions}>
          <Button size="sm" variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button size="sm" variant="primary" disabled={busy || draft.name.trim() === '' || draft.url.trim() === ''} onClick={() => { void submit() }}>{t('save')}</Button>
        </div>
      )}>
      <div className={css.dialog}>
        {field('name', t('custom.name'), t('custom.namePlaceholder'))}
        {field('url', t('custom.url'), 'https://example.com/mcp')}
        {field('headerName', t('custom.headerName'), 'Authorization')}
        {field('headerValue', t('custom.headerValue'), 'Bearer …', true)}
        <div className={css.note}>{t('custom.headerHint')}</div>
        {failure !== undefined && <div className={css.error}>{failure}</div>}
      </div>
    </Modal>
  )
}

/**
 * Render the Connectors page.
 * @param props - the connector stream, actions, and localized copy.
 * @returns the page.
 */
export function ConnectorsPage(props: Props): ReactNode {
  const { t, useConnectors } = props
  const state = useConnectors(value => value)
  const [query, setQuery] = useState('')
  const [customOpen, setCustomOpen] = useState(false)
  const connectors = state.status === 'ready' ? state.snapshot.connectors : []
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = needle === ''
      ? connectors
      : connectors.filter(item => `${item.name} ${item.description} ${t(`category.${item.category}`)}`.toLowerCase().includes(needle))
    return CATEGORIES
      .map(category => ({ category, items: matches.filter(item => item.category === category) }))
      .filter(group => group.items.length > 0)
  }, [connectors, query, t])
  const connected = connectors.filter(item => item.phase === 'connected' || item.phase === 'builtin').length
  return (
    <div className={css.page}>
      <div className={css.body}>
        <header className={css.header}>
          <div>
            <h1 className={css.title}>{t('title')}</h1>
            <p className={css.intro}>{t('intro')}{state.status === 'ready' && <> · {t('connectedCount', { count: connected })}</>}</p>
          </div>
          <Button variant="primary" size="md" icon={<IconPlusOutlineRegular size={16} />} onClick={() => { setCustomOpen(true) }}>{t('addCustom')}</Button>
        </header>
        <div className={css.search}>
          <Input icon={<IconSearchOutlineRegular size={16} />} value={query} placeholder={t('search')} aria-label={t('search')}
            onChange={(event) => { setQuery(event.target.value) }} />
        </div>
        {state.status === 'loading' && <p className={css.note}>{t('loading')}</p>}
        {state.status === 'failed' && <p className={css.error}>{t('loadFailed')}</p>}
        {state.status === 'ready' && groups.length === 0 && <p className={css.note}>{t('noMatches')}</p>}
        {groups.map(group => (
          <section key={group.category} className={css.section} aria-label={t(`category.${group.category}`)}>
            <h2 className={css.sectionTitle}>{t(`category.${group.category}`)}<span className={css.count}>{group.items.length}</span></h2>
            <ul className={css.list}>
              {group.items.map(connector => <ConnectorRow key={connector.id} connector={connector} props={props} />)}
            </ul>
          </section>
        ))}
      </div>
      {customOpen && <CustomDialog props={props} onClose={() => { setCustomOpen(false) }} />}
    </div>
  )
}
