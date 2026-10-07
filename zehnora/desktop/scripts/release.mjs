// Publishes the desktop installers and the download manifest the console's /download page reads.
//   node scripts/release.mjs             write ../portal/public/downloads.json from release/ (dry run)
//   node scripts/release.mjs --publish   also create the GitHub release and upload the installers (needs `gh auth login`)
// Repo for the public releases: ZEHNORA_RELEASE_REPO (default Inshal-Amir/Maitre-Desktop). Notes: ZEHNORA_RELEASE_NOTES or release-notes.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const repo = process.env.ZEHNORA_RELEASE_REPO ?? 'Inshal-Amir/Maitre-Desktop';
const tag = `v${version}`;
const publish = process.argv.includes('--publish');

const TARGETS = [
  { id: 'windows', os: 'Windows', label: 'Windows 10 and 11 (64-bit)', file: `Maitre-Setup-${version}.exe` },
  { id: 'mac-arm64', os: 'macOS', label: 'Mac with Apple silicon (M1–M4)', file: `Maitre-${version}-mac-arm64.dmg` },
  { id: 'mac-x64', os: 'macOS', label: 'Mac with Intel processor', file: `Maitre-${version}-mac-x64.dmg` },
];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const notesFile = path.join(desktop, 'release-notes.md');
const notes = (process.env.ZEHNORA_RELEASE_NOTES ?? (fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '')).trim();

const files = TARGETS.map((target) => {
  const local = path.join(desktop, 'release', target.file);
  if (!fs.existsSync(local)) throw new Error(`missing ${local}: run npm run dist:mac and npm run dist:win first`);
  return { ...target, local, size: fs.statSync(local).size, sha256: sha256(local), url: `https://github.com/${repo}/releases/download/${tag}/${target.file}` };
});

if (publish) {
  const gh = (...args) => execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
  try {
    gh('repo', 'view', repo, '--json', 'name');
  } catch {
    // A release needs at least one commit, so the repository starts with a README.
    gh('repo', 'create', repo, '--public', '--add-readme', '--description', 'Maitre Desktop installers for Windows and macOS');
  }
  const exists = (() => {
    try {
      gh('release', 'view', tag, '--repo', repo);
      return true;
    } catch {
      return false;
    }
  })();
  if (!exists) gh('release', 'create', tag, '--repo', repo, '--title', `Maitre Desktop ${version}`, '--notes', notes || `Maitre Desktop ${version}`);
  gh('release', 'upload', tag, '--repo', repo, '--clobber', ...files.map((f) => f.local));
  console.log(`published ${tag} to https://github.com/${repo}/releases/tag/${tag}`);
}

const manifest = {
  version,
  released: new Date().toISOString().slice(0, 10),
  notes,
  page: `https://github.com/${repo}/releases/tag/${tag}`,
  files: files.map(({ local: _local, ...rest }) => rest),
};
const out = path.resolve(desktop, '../portal/public/downloads.json');
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${out}${publish ? '' : ' (dry run: nothing uploaded)'}`);
