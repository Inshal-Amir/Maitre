/**
 * Connectors, browser half: the **Connectors** sidebar entry and the page it
 * opens in the main column. The page streams the Host's connector state
 * through `ctx.remote.connectors.watch` and connects, disconnects, and adds
 * custom connectors through the same namespace. A browser sign-in opens in a
 * tab this page owns: it is opened on the click, then pointed at the
 * authorization page once the Host knows it.
 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectOutcome, ConnectorsSnapshot, ConnectRequest, CustomConnectorRequest } from '../types.ts'
import { ConnectorsPage } from './ConnectorsPage.tsx'
import type { ConnectorsInjected, ConnectorsPageState } from './ConnectorsPage.tsx'
import { ConnectorsPanelIcon } from './ConnectorsPanelIcon.tsx'
import { en, ja, es, fr, de, ru, pt, zh, type ConnectorsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Connectors page copy. */
    'connectors': ConnectorsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'connectors'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'connectors' as MainPanelId

/** Services the page needs. */
export const inject = ['slots', 'locale', 'remote', 'remote.connectors', 'layout', 'remoteAccess']

const failed = (message: string): ConnectOutcome => ({ kind: 'failed', message })

/**
 * Contribute the Connectors sidebar entry and page while the current Peer may watch connectors.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-connectors: dictionaries')
  const t = ctx.locale.bind(NS)
  let state: ConnectorsPageState = { status: 'loading' }
  const listeners = new Set<() => void>()
  const publish = (next: ConnectorsPageState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const source = {
    getSnapshot: (): ConnectorsPageState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  /** Point a tab opened on the click at the sign-in page, or close it when no sign-in follows. */
  const settle = (tab: Window | null, outcome: ConnectOutcome): ConnectOutcome => {
    if (outcome.kind === 'authorizing' && tab !== null && !tab.closed) tab.location.href = outcome.authUrl
    else tab?.close()
    return outcome
  }
  const call = async (
    run: () => Promise<{ ok: true; value: ConnectOutcome } | { ok: false }>,
    tab: Window | null,
  ): Promise<ConnectOutcome> => {
    try {
      const result = await run()
      return settle(tab, result.ok ? result.value : failed(t('loadFailed')))
    } catch (error) {
      tab?.close()
      return failed(error instanceof Error ? error.message : String(error))
    }
  }
  const injected: ConnectorsInjected = {
    hooks: { connectors: source },
    connect: (request: ConnectRequest, signIn: boolean) => {
      const tab = signIn ? window.open('about:blank', '_blank') : null
      return call(() => ctx.remote.connectors.connect(request), tab)
    },
    addCustom: (request: CustomConnectorRequest) => {
      // A custom server's sign-in need is known only after the Host probes it.
      const tab = request.headerName === undefined || request.headerName === '' ? window.open('about:blank', '_blank') : null
      return call(() => ctx.remote.connectors.addCustom(request), tab)
    },
    disconnect: async (id: string) => {
      await ctx.remote.connectors.disconnect(id)
    },
    cancel: async (id: string) => {
      await ctx.remote.connectors.cancel(id)
    },
  }

  ctx.remoteAccess.whenAccess('connectors/watch', function* () {
    const stream = ctx.remote.$stream<ConnectorsSnapshot>({
      name: 'connectors',
      open: signal => ctx.remote.connectors.watch(signal),
      ended: () => new Error('connectors stream ended'),
      carrierFailed: () => { publish({ status: 'failed' }) },
    })
    const grant = { ended: false }
    yield () => {
      grant.ended = true
      publish({ status: 'loading' })
      return stream.dispose()
    }
    void (async () => {
      for await (const frame of stream) {
        if (grant.ended) return
        publish({ status: 'ready', snapshot: frame.value })
        frame.accept()
      }
    })().catch(() => { publish({ status: 'failed' }) })
    yield ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: () => injected,
    }, ConnectorsPage))
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 5,
      label: () => t('panel'),
      locale: NS,
    }, ConnectorsPanelIcon))
  })
}
