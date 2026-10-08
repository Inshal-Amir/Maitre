// Live Google check: the real Electron app, the owner's OAuth client and a real Google sign-in in the browser.
// A scripted mock model makes READ-ONLY tool calls (Gmail search, Calendar list, Drive search) so this works
// while the GPU server is offline. Run: node tests/google-live.mjs  (someone must finish sign-in in the browser).
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockModel } from './mock-model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'maitre-google-live-'));
const READS = [
  { name: 'google_gmail_search', arguments: JSON.stringify({ query: 'newer_than:30d', max_results: 3 }) },
  { name: 'google_calendar_list_events', arguments: JSON.stringify({}) },
  { name: 'google_drive_search', arguments: JSON.stringify({ query: "trashed = false", max_results: 3 }) },
];
const mock = await startMockModel((body) => (body.messages.some((m) => m.role === 'tool') ? { content: 'Checked Gmail, Calendar and Drive.' } : { tool_calls: READS }));

const app = await electron.launch({ args: ['.'], cwd: desktop, env: { ...process.env, MAITRE_USER_DATA: userData, MAITRE_API_BASE: mock.url, MAITRE_API_KEY: mock.apiKey } });
app.process().stdout.on('data', (d) => process.stdout.write(`  [main] ${d}`));
app.process().stderr.on('data', (d) => process.stdout.write(`  [main:err] ${d}`));
app.on('close', () => console.log('  [app closed]'));
const page = await app.firstWindow();
let ok = false;
try {
  await page.waitForSelector('.sidebar');
  await page.click('.status');
  await page.waitForSelector('.connector');
  const before = await page.innerText('.connector');
  console.log('Google card:', before.split('\n').slice(0, 2).join(' | '));
  for (const service of ['Docs', 'Sheets']) await page.click(`label.service:has-text("${service}") input`);
  await page.click('button:has-text("Connect Google")');
  console.log('>>> Browser opened: sign in with a test-user Google account and allow access (5 minutes).');
  await page.waitForSelector('.connector .field-note:has-text("tools available")', { timeout: 300_000 });
  console.log('Connected:', (await page.innerText('.connector')).split('\n').filter(Boolean).slice(0, 3).join(' | '));
  await page.keyboard.press('Escape');
  await page.fill('textarea', 'check my google');
  await page.keyboard.press('Enter');
  await page.locator('.markdown:has-text("Checked Gmail")').waitFor({ timeout: 90_000 });
  const results = mock.requests[mock.requests.length - 1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
  READS.forEach((call, i) => {
    const text = results[i] ?? '';
    const failed = /^Error:/.test(text);
    console.log(`\n[${failed ? 'FAIL' : 'PASS'}] ${call.name}\n${text.split('\n').slice(0, 4).map((l) => '   ' + l.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>').slice(0, 110)).join('\n')}`);
  });
  ok = results.length === READS.length && results.every((text) => !/^Error:/.test(text));
  await page.screenshot({ path: path.join(desktop, '../tests/evidence/desktop/10-google-live.png') });
} catch (error) {
  console.log('FAILED:', error.message.split('\n')[0]);
} finally {
  await app.close();
  await mock.close();
  fs.rmSync(userData, { recursive: true, force: true });
}
console.log(ok ? '\nGoogle live check passed' : '\nGoogle live check did not pass');
process.exit(ok ? 0 : 1);
