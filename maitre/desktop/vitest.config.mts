import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/** Tests never read or write the real ~/.maitre or ~/.claude. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maitre-home-'));

export default defineConfig({
  resolve: { alias: { electron: path.resolve(__dirname, 'tests/stubs/electron.ts') } },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    env: { MAITRE_HOME: path.join(home, 'maitre'), MAITRE_CLAUDE_HOME: path.join(home, 'claude'), MAITRE_GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', MAITRE_GOOGLE_API_BASE: 'http://127.0.0.1:45871', MAITRE_GOOGLE_OAUTH_BASE: 'http://127.0.0.1:45871' },
  },
});
