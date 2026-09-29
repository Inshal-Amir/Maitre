// Live check against the real GPU model: the real app, one Chat question and one Work task. Uses the desktop test key.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePdf } from './fixtures/make-pdf.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const evidence = path.resolve(desktop, '../tests/evidence/desktop');
const key = fs.readFileSync(path.resolve(desktop, '../../.local-dev/client/secrets/desktop-test-key'), 'utf8').trim();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zehnora-live-'));
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zehnora-live-work-')));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ defaultWorkDir: workDir }));
const app = await electron.launch({ args: ['.'], cwd: desktop, env: { ...process.env, ZEHNORA_USER_DATA: userData, ZEHNORA_API_KEY: key } });
const page = await app.firstWindow();
const last = () => page.locator('.turn.assistant').last();
const done = () => page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 600_000 });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`); };
try {
  await page.waitForSelector('.status .dot.online', { timeout: 30_000 });
  let t0 = Date.now();
  if (process.env.ONLY_PDF) {
    await page.click('.mode-switch button:has-text("Work")');
  } else {
  await page.click('.mode-switch button:has-text("Chat")');
  await page.fill('textarea', 'Assalam o alaikum! Mera naam Inshal hai, yaad rakhna. Ek line mein batao tum kaun ho.');
  await page.keyboard.press('Enter');
  await page.locator('.streaming').first().waitFor({ timeout: 300_000 }).then(() => console.log(`  streaming started after ${((Date.now() - t0) / 1000).toFixed(1)}s`), () => undefined);
  await done();
  const chat = await last().innerText();
  check('chat reply arrives streamed', chat.length > 20 && !(await last().locator('.step-error').count()), `${((Date.now() - t0) / 1000).toFixed(0)}s: ${chat.replace(/\s+/g, ' ').slice(0, 160)}`);
  const memories = JSON.parse(fs.readFileSync(path.join(userData, 'memories.json'), 'utf8').toString() || '[]');
  check('model saved the name to memory', memories.some((m) => /Inshal/i.test(m.text)), JSON.stringify(memories.map((m) => m.text)));
  await page.screenshot({ path: path.join(evidence, 'live-chat.png') });

  await page.click('.new-chat');
  t0 = Date.now();
  await page.fill('textarea', 'Latest stable version of Node.js kya hai? Web search karke batao, source link ke saath.');
  await page.keyboard.press('Enter');
  await done();
  const search = await last().innerText();
  const tools = await last().locator('.tool .tool-label').allInnerTexts();
  check('chat uses web search and cites', tools.some((t) => /search/i.test(t)) && /http/.test(await last().innerHTML()), `${((Date.now() - t0) / 1000).toFixed(0)}s, tools: ${tools.join(' | ').slice(0, 160)}`);
  console.log('  answer:', search.replace(/\s+/g, ' ').slice(-220));

  await page.click('.mode-switch button:has-text("Work")');
  await page.click('.new-chat');
  t0 = Date.now();
  await page.fill('textarea', 'Is folder mein "hello" naam ka folder banao, us mein hello.py likho jo "Hello from Zehnora" print kare, phir usay python3 se chala ke output batao.');
  await page.keyboard.press('Enter');
  await done();
  const work = await last().innerText();
  const workTools = await last().locator('.tool .tool-label').allInnerTexts();
  const file = path.join(workDir, 'hello', 'hello.py');
  check('work task creates and runs the script', fs.existsSync(file) && /Hello from Zehnora/.test(work), `${((Date.now() - t0) / 1000).toFixed(0)}s, tools: ${workTools.join(' | ').slice(0, 200)}`);
  await page.screenshot({ path: path.join(evidence, 'live-work.png') });
  }

  const pdf = makePdf(path.join(workDir, 'invoice.pdf'), ['Invoice 2291 from Nutech Labs', 'Amount due: 48,750 PKR by 15 October 2026']);
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, pdf);
  await page.click('.new-chat');
  await page.click('button.attach');
  await page.waitForSelector('.attachments .attachment:has-text("invoice.pdf")');
  t0 = Date.now();
  await page.fill('textarea', 'Is invoice mein kitni raqam kab tak deni hai?');
  await page.keyboard.press('Enter');
  await done();
  const answer = await last().innerText();
  check('model answers from the attached PDF', /48[,.]?750/.test(answer) && /15/.test(answer), `${((Date.now() - t0) / 1000).toFixed(0)}s: ${answer.replace(/\s+/g, ' ').slice(-160)}`);
  await page.screenshot({ path: path.join(evidence, 'live-pdf.png') });
} catch (error) {
  check('unexpected error', false, error.message.split('\n')[0]);
} finally {
  await app.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} live checks passed`);
