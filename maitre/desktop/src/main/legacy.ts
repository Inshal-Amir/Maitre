import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/** The product's name before it became Maitre; used only to carry existing data over to the new names. */
const OLD_NAME = 'Zehnora';

/** The model alias from before the rename; saved settings that still use it are rewritten. */
export const OLD_MODEL = 'zehnora-coder';

const holdsAppData = (dir: string): boolean => fs.existsSync(path.join(dir, 'settings.json')) || fs.existsSync(path.join(dir, 'conversations'));

/**
 * Moves the old app-data folder to the new location the first time Maitre starts. A new folder that holds only
 * browser caches (no settings or chats yet) is replaced; one with Maitre's own data is never touched.
 */
export function adoptOldUserData(appData: string, userData: string): void {
  const old = path.join(appData, OLD_NAME);
  if (!holdsAppData(old)) return;
  if (holdsAppData(userData)) return copyMissingChats(old, userData);
  fs.rmSync(userData, { recursive: true, force: true });
  fs.renameSync(old, userData);
}

/** When both folders hold data, chats that exist only in the old one are copied over once; nothing is overwritten. */
function copyMissingChats(oldDir: string, userData: string): void {
  const from = path.join(oldDir, 'conversations');
  const marker = path.join(userData, '.old-chats-imported');
  if (!fs.existsSync(from) || fs.existsSync(marker)) return;
  fs.writeFileSync(marker, new Date().toISOString());
  const to = path.join(userData, 'conversations');
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (!fs.existsSync(path.join(to, name))) fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
}

/** The work folder of earlier versions, kept when it exists so saved chats keep pointing at it. */
export function oldWorkDir(): string | null {
  const dir = path.join(os.homedir(), OLD_NAME);
  return fs.existsSync(dir) ? dir : null;
}

/** Renames a project's old memory folder to the new one, once. */
export function adoptOldProjectDir(root: string, dir: string): void {
  const old = path.join(root, `.${OLD_NAME.toLowerCase()}`);
  const next = path.join(root, dir);
  if (fs.existsSync(next) || !fs.existsSync(old)) return;
  fs.renameSync(old, next);
}
