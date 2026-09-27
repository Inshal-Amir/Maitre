import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Redirect {
  code: string;
  state: string;
}

export interface LoopbackListener {
  redirectUri: string;
  result: Promise<Redirect>;
  close(): void;
}

const PAGE = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px -apple-system,Segoe UI,sans-serif;display:grid;place-items:center;height:90vh;color:#18181b"><div style="text-align:center"><h2>${title}</h2><p>${text}</p></div>`;

/**
 * Listens once on 127.0.0.1 for an OAuth redirect (RFC 8252 loopback flow). Port 0 picks a free port,
 * which Google "Desktop app" clients accept; servers that register a fixed redirect need a fixed port.
 */
export async function listenForRedirect(port = 0, path = '/callback', timeoutMs = 300_000): Promise<LoopbackListener> {
  let settle: { resolve(value: Redirect): void; reject(error: Error): void } | null = null;
  const result = new Promise<Redirect>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
    if (error || !code) {
      res.end(PAGE('Not connected', 'Sign-in was cancelled or refused. You can close this tab and try again in Zehnora.'));
      settle?.reject(new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in failed: ${error ?? 'no code returned'}`));
    } else {
      res.end(PAGE('Connected to Zehnora', 'You can close this tab and return to the app.'));
      settle?.resolve({ code, state: url.searchParams.get('state') ?? '' });
    }
    setImmediate(close);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const timer = setTimeout(() => {
    settle?.reject(new Error('Sign-in timed out after 5 minutes.'));
    close();
  }, timeoutMs);
  function close(): void {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
  const { port: actual } = server.address() as AddressInfo;
  return { redirectUri: `http://127.0.0.1:${actual}${path}`, result, close };
}
