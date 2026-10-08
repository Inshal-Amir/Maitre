import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/** The product's name before it became Maitre; used only to carry existing data over to the new names. */
const OLD_NAME = 'Zehnora';

/** The model alias from before the rename; saved settings that still use it are rewritten. */
export const OLD_MODEL = 'zehnora-coder';

/** Moves the old app-data folder to the new location the first time Maitre starts. */
export function adoptOldUserData(appData: string, userData: string): void {
  const old = path.join(appData, OLD_NAME);
  if (fs.existsSync(userData) || !fs.existsSync(old)) return;
  fs.renameSync(old, userData);
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
