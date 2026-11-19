// Publishes the desktop installers and the download manifest the console's /download page reads.
//   node maitre/scripts/release-desktop.mjs <version> <dir>             write portal/public/downloads.json (dry run)
//   node maitre/scripts/release-desktop.mjs <version> <dir> --publish   also create the GitHub release and upload (needs `gh auth login`)
// <dir> holds the installers the "Desktop installers" workflow (or a local build) produced: one *-mac-arm64*.dmg,
// one *-mac-x64*.dmg and one *-win-x64*.exe. They are copied to the public names below before upload.
// Repo for the public releases: MAITRE_RELEASE_REPO (default Inshal-Amir/Maitre-Desktop). Notes: MAITRE_RELEASE_NOTES or
// maitre/desktop/release-notes.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const maitre = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [version, input] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !input) {
  throw new Error('usage: release-desktop.mjs <version e.g. 0.8.0> <installer directory> [--publish]');
}
const repo = process.env.MAITRE_RELEASE_REPO ?? 'Inshal-Amir/Maitre-Desktop';
const tag = `v${version}`;
const publish = process.argv.includes('--publish');

const TARGETS = [
  { id: 'windows', os: 'Windows', label: 'Windows 10 and 11 (64-bit)', match: /-win-x64.*\.exe$/, file: `Maitre-Setup-${version}.exe` },
  { id: 'mac-arm64', os: 'macOS', label: 'Mac with Apple silicon (M1–M4)', match: /-mac-arm64.*\.dmg$/, file: `Maitre-${version}-mac-arm64.dmg` },
  { id: 'mac-x64', os: 'macOS', label: 'Mac with Intel processor', match: /-mac-x64.*\.dmg$/, file: `Maitre-${version}-mac-x64.dmg` },
];

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
const found = walk(path.resolve(input));
const staging = path.join(path.resolve(input), 'release');
fs.mkdirSync(staging, { recursive: true });

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const notesFile = path.join(maitre, 'desktop', 'release-notes.md');
const notes = (process.env.MAITRE_RELEASE_NOTES ?? (fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '')).trim();

const files = TARGETS.map(({ match, ...target }) => {
  const source = found.filter((file) => match.test(path.basename(file)) && !file.startsWith(staging));
  if (source.length !== 1) throw new Error(`expected exactly one ${target.id} installer in ${input}, found ${source.length}`);
  const local = path.join(staging, target.file);
  fs.copyFileSync(source[0], local);
  return { ...target, local, size: fs.statSync(local).size, sha256: sha256(local), url: `https://github.com/${repo}/releases/download/${tag}/${target.file}` };
});

if (publish) {
  const gh = (...args) => execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
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
const out = path.join(maitre, 'portal', 'public', 'downloads.json');
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${out}${publish ? '' : ' (dry run: nothing uploaded)'}`);
