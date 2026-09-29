// Live check of the Work agent's workflow on the real GPU model: questions first, then project folder, brief and plan.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const evidence = path.resolve(desktop, '../tests/evidence/desktop');
const key = fs.readFileSync(path.resolve(desktop, '../../.local-dev/client/secrets/desktop-test-key'), 'utf8').trim();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zehnora-live-agent-'));
const workRoot = path.join(os.homedir(), 'Zehnora-live-test');
fs.mkdirSync(workRoot, { recursive: true });
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ defaultWorkDir: workRoot, memoryEnabled: false }));
const app = await electron.launch({ args: ['.'], cwd: desktop, env: { ...process.env, ZEHNORA_USER_DATA: userData, ZEHNORA_API_KEY: key } });
const page = await app.firstWindow();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`); };
const toolNames = () => page.locator('.tool .tool-label').allInnerTexts();
try {
  await page.waitForSelector('.status .dot.online', { timeout: 30_000 });
  await page.click('.mode-switch button:has-text("Work")');
  const t0 = Date.now();
  await page.fill('textarea', 'Mere liye ek website banao');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.question', { timeout: 400_000 });
  const before = await toolNames();
  check('asks the user before doing anything else', before.length === 1, `${((Date.now() - t0) / 1000).toFixed(0)}s; tools so far: ${before.join(' | ')}`);
  const questions = await page.locator('.question-text').allInnerTexts();
  console.log('  questions:', questions.join(' / '));
  check('asks where to create the project, with a proposed path', questions.some((q) => /where|folder|path|kahan/i.test(q)) && (await page.locator('.question .option.path').count()) > 0 && (await page.locator('.question .browse').count()) > 0);
  await page.screenshot({ path: path.join(evidence, 'live-agent-questions.png') });
  const inputs = page.locator('.question-input');
  const count = await inputs.count();
  const answers = ['A portfolio website for Inshal, a software engineer: home, projects and contact pages', 'Simple, clean and modern', 'Plain HTML, CSS and JavaScript (no framework)', `Create it in ${path.join(workRoot, 'portfolio')}`, 'No deployment for now'];
  for (let i = 0; i < count; i++) {
    const text = await page.locator('.question-text').nth(i).innerText();
    const answer = /where|folder|path|location|kahan/i.test(text) ? answers[3] : /style|design|look/i.test(text) ? answers[1] : /stack|tech|framework|build it with/i.test(text) ? answers[2] : /deploy|host/i.test(text) ? answers[4] : answers[0];
    await inputs.nth(i).fill(answer);
  }
  await page.click('.question button:has-text("Send answers")');
  const planned = await page.waitForSelector('.plan .plan-step', { timeout: 600_000 }).then(() => true, () => false);
  const after = await toolNames();
  console.log('  tools:', after.join(' | '));
  const projectDir = fs.readdirSync(workRoot).map((d) => path.join(workRoot, d)).find((d) => fs.existsSync(path.join(d, '.zehnora')));
  check('sets the project folder and writes the brief', Boolean(projectDir) && fs.existsSync(path.join(projectDir, '.zehnora/brief.md')) && !/not written yet/.test(fs.readFileSync(path.join(projectDir, '.zehnora/brief.md'), 'utf8')), projectDir ?? 'no .zehnora folder');
  check('creates a plan shown as a checklist', planned, planned ? (await page.innerText('.plan')).replace(/\n+/g, ' | ').slice(0, 300) : '');
  await page.screenshot({ path: path.join(evidence, 'live-agent-plan.png') });
  if (projectDir) console.log('  brief:\n' + fs.readFileSync(path.join(projectDir, '.zehnora/brief.md'), 'utf8').split('\n').slice(0, 14).map((l) => '    ' + l).join('\n'));
} catch (error) {
  check('unexpected error', false, error.message.split('\n')[0]);
} finally {
  await page.click('.send.stop').catch(() => undefined);
  await app.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} live agent checks passed`);
