// Mock of the Google OAuth and REST endpoints used by the built-in Google connector.
import http from 'node:http';

export async function startMockGoogle(port) {
  const log = [];
  const tokens = { current: 'at-1' };
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const b64 = (text) => Buffer.from(text).toString('base64url');
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const route = `${req.method} ${decodeURIComponent(url.pathname)}`;
      log.push({ route, query: Object.fromEntries(url.searchParams), body: raw, auth: req.headers.authorization });
      if (route === 'POST /token') {
        const form = new URLSearchParams(raw);
        if (form.get('grant_type') === 'authorization_code') {
          if (form.get('code') !== 'good-code' || !form.get('code_verifier')) return json(res, 400, { error: 'invalid_grant' });
          return json(res, 200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: `openid email ${form.get('scope') ?? ''} https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.events` });
        }
        if (form.get('refresh_token') !== 'rt-1') return json(res, 400, { error: 'invalid_grant' });
        tokens.current = 'at-2';
        return json(res, 200, { access_token: 'at-2', expires_in: 3600 });
      }
      if (route === 'GET /v1/userinfo') return json(res, 200, { email: 'tester@gmail.com' });
      if (route === 'POST /revoke') return json(res, 200, {});
      if (req.headers.authorization !== `Bearer ${tokens.current}`) return json(res, 401, { error: { message: 'Invalid Credentials' } });
      if (route === 'GET /gmail/v1/users/me/messages') return json(res, 200, { messages: [{ id: 'm1' }] });
      if (route === 'GET /gmail/v1/users/me/messages/m1') {
        const headers = [{ name: 'From', value: 'Ali <ali@example.com>' }, { name: 'To', value: 'tester@gmail.com' }, { name: 'Subject', value: 'Project meeting' }, { name: 'Date', value: 'Fri, 25 Sep 2026 10:00:00 +0500' }];
        if (url.searchParams.get('format') === 'metadata') return json(res, 200, { id: 'm1', threadId: 't1', snippet: 'Can we meet Monday?', labelIds: ['UNREAD'], payload: { headers } });
        return json(res, 200, { id: 'm1', threadId: 't1', payload: { mimeType: 'multipart/alternative', headers, parts: [{ mimeType: 'text/plain', body: { data: b64('Hi, can we meet Monday at 3?') } }, { mimeType: 'text/html', body: { data: b64('<p>Hi</p>') } }] } });
      }
      if (route === 'POST /gmail/v1/users/me/drafts') return json(res, 200, { id: 'd1' });
      if (route === 'POST /gmail/v1/users/me/messages/send') return json(res, 200, { id: 's1' });
      if (route === 'GET /calendar/v3/calendars/primary/events') return json(res, 200, { timeZone: 'Asia/Karachi', items: [{ id: 'e1', summary: 'Standup', start: { dateTime: '2026-09-28T10:00:00+05:00' }, end: { dateTime: '2026-09-28T10:15:00+05:00' } }] });
      if (route === 'POST /calendar/v3/calendars/primary/events') {
        const body = JSON.parse(raw);
        return json(res, 200, { id: 'e2', summary: body.summary, start: body.start, htmlLink: 'https://calendar.google.com/e2' });
      }
      if (route === 'GET /drive/v3/files') return json(res, 200, { files: [{ id: 'f1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-09-20T00:00:00Z', webViewLink: 'https://docs.google.com/f1' }] });
      if (route === 'GET /drive/v3/files/f1') return json(res, 200, { id: 'f1', name: 'Plan', mimeType: 'application/vnd.google-apps.document' });
      if (route === 'GET /drive/v3/files/f1/export') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Step 1: build the app'); }
      if (route === 'POST /upload/drive/v3/files') return json(res, 200, { id: 'f2', name: 'notes.txt', webViewLink: 'https://drive.google.com/f2' });
      if (route === 'POST /v1/documents') return json(res, 200, { documentId: 'doc1', title: JSON.parse(raw).title });
      if (route === 'POST /v1/documents/doc1:batchUpdate') return json(res, 200, {});
      if (route === 'GET /v4/spreadsheets/s1/values/Sheet1!A1:B2') return json(res, 200, { range: 'Sheet1!A1:B2', values: [['name', 'score'], ['Ali', '9']] });
      if (route === 'PUT /v4/spreadsheets/s1/values/Sheet1!A3') return json(res, 200, { updatedRange: 'Sheet1!A3:B3', updatedCells: 2 });
      json(res, 404, { error: { message: `mock has no ${route}` } });
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${port}`, log, tokens, close: () => new Promise((r) => server.close(r)) };
}
