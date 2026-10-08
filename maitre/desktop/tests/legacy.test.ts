import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptOldProjectDir, adoptOldUserData } from '../src/main/legacy';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maitre-legacy-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('carrying data over from the old name', () => {
  it('moves the old app-data folder once, and never over an existing one', () => {
    const appData = tmp();
    fs.mkdirSync(path.join(appData, 'Zehnora', 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(appData, 'Zehnora', 'settings.json'), '{}');
    const userData = path.join(appData, 'Maitre');
    adoptOldUserData(appData, userData);
    expect(fs.existsSync(path.join(userData, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(appData, 'Zehnora'))).toBe(false);

    fs.mkdirSync(path.join(appData, 'Zehnora', 'conversations'), { recursive: true });
    adoptOldUserData(appData, userData);
    expect(fs.existsSync(path.join(appData, 'Zehnora'))).toBe(true);
  });

  it('copies chats that exist only in the old folder when both hold data', () => {
    const appData = tmp();
    const oldChats = path.join(appData, 'Zehnora', 'conversations');
    const newChats = path.join(appData, 'Maitre', 'conversations');
    fs.mkdirSync(oldChats, { recursive: true });
    fs.mkdirSync(newChats, { recursive: true });
    fs.writeFileSync(path.join(oldChats, 'a.json'), 'old-a');
    fs.writeFileSync(path.join(oldChats, 'b.json'), 'old-b');
    fs.writeFileSync(path.join(newChats, 'b.json'), 'new-b');
    adoptOldUserData(appData, path.join(appData, 'Maitre'));
    expect(fs.readFileSync(path.join(newChats, 'a.json'), 'utf8')).toBe('old-a');
    expect(fs.readFileSync(path.join(newChats, 'b.json'), 'utf8')).toBe('new-b');

    fs.rmSync(path.join(newChats, 'a.json'));
    adoptOldUserData(appData, path.join(appData, 'Maitre'));
    expect(fs.existsSync(path.join(newChats, 'a.json'))).toBe(false);
  });

  it('replaces a new folder that holds only browser caches', () => {
    const appData = tmp();
    fs.mkdirSync(path.join(appData, 'Zehnora', 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(appData, 'Zehnora', 'conversations', 'chat.json'), '{}');
    const userData = path.join(appData, 'Maitre');
    fs.mkdirSync(path.join(userData, 'GPUCache'), { recursive: true });
    adoptOldUserData(appData, userData);
    expect(fs.existsSync(path.join(userData, 'conversations', 'chat.json'))).toBe(true);
    expect(fs.existsSync(path.join(userData, 'GPUCache'))).toBe(false);
  });

  it('renames a project memory folder to .maitre', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.zehnora'));
    fs.writeFileSync(path.join(root, '.zehnora', 'brief.md'), 'goal');
    adoptOldProjectDir(root, '.maitre');
    expect(fs.readFileSync(path.join(root, '.maitre', 'brief.md'), 'utf8')).toBe('goal');
    expect(fs.existsSync(path.join(root, '.zehnora'))).toBe(false);
  });
});
