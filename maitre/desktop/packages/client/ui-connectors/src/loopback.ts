/** One-shot loopback listener for an OAuth redirect (RFC 8252 section 7.3) and the system browser opener. */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/** The authorization response a redirect delivered. */
export interface Redirect {
  code: string
  state: string
  /** RFC 9207 `iss` parameter, when the authorization server sends one. */
  iss?: string
}

/** A listening redirect endpoint. */
export interface LoopbackListener {
  /** `http://127.0.0.1:<port><path>` as registered with the authorization server. */
  readonly redirectUri: string
  /** Settles with the first redirect on `path`, or rejects on an error redirect, timeout, or abort. */
  readonly result: Promise<Redirect>
  /** Stop listening; idempotent. */
  close(): void
}

const page = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px -apple-system,Segoe UI,sans-serif;display:grid;place-items:center;height:90vh;color:#18181b"><div style="text-align:center"><h2>${title}</h2><p>${text}</p></div>`

/**
 * Listen once on 127.0.0.1 for an OAuth redirect.
 * @param port - fixed port, or 0 for an ephemeral one.
 * @param path - redirect path.
 * @param timeoutMs - how long to wait for the redirect.
 * @param signal - aborts the wait and closes the listener.
 * @returns the listener once it is bound.
 */
export async function listenForRedirect(port: number, path: string, timeoutMs: number, signal: AbortSignal): Promise<LoopbackListener> {
  const settled = Promise.withResolvers<Redirect>()
  // The rejection is observed by whoever awaits `result`; this keeps an unawaited one from surfacing as unhandled.
  settled.promise.catch(() => undefined)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== path) {
      res.writeHead(404).end()
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
    if (error !== null || code === null) {
      res.end(page('Not connected', 'Sign-in was cancelled or refused. You can close this tab and try again in Maitre.'))
      settled.reject(new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in failed: ${error ?? 'no code returned'}`))
    } else {
      res.end(page('Connected to Maitre', 'You can close this tab and return to Maitre.'))
      const iss = url.searchParams.get('iss')
      settled.resolve({ code, state: url.searchParams.get('state') ?? '', ...(iss === null ? {} : { iss }) })
    }
    setImmediate(close)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { resolve() })
  })
  const timer = setTimeout(() => {
    settled.reject(new Error(`Sign-in timed out after ${String(Math.round(timeoutMs / 60_000))} minutes.`))
    close()
  }, timeoutMs)
  const onAbort = (): void => {
    settled.reject(new Error('Sign-in was cancelled.'))
    close()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  function close(): void {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    server.close()
    server.closeAllConnections()
  }
  const { port: actual } = server.address() as AddressInfo
  return { redirectUri: `http://127.0.0.1:${String(actual)}${path}`, result: settled.promise, close }
}

/**
 * Hand one URL to the operating system's default browser.
 * @param url - the page to open.
 * @returns resolution once the launcher started; launcher failures are reported, not thrown.
 */
export async function openSystemBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : ['xdg-open', [url]]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
