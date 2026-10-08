import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'maitre-test-'));

export const app = { getPath: (): string => userData };
export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (text: string): Buffer => Buffer.from(text, 'utf8').reverse(),
  decryptString: (buffer: Buffer): string => Buffer.from(buffer).reverse().toString('utf8'),
};
export const shell = {
  trashItem: async (target: string): Promise<void> => fs.rmSync(target, { recursive: true, force: true }),
  openExternal: async (): Promise<void> => undefined,
  openPath: async (): Promise<string> => '',
};
export class BrowserWindow {
  constructor() {
    throw new Error('BrowserWindow is not available in unit tests');
  }
}
export const session = { fromPartition: (): never => { throw new Error('session is not available in unit tests'); } };
