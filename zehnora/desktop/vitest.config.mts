import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { electron: path.resolve(__dirname, 'tests/stubs/electron.ts') } },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    env: { ZEHNORA_GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', ZEHNORA_GOOGLE_API_BASE: 'http://127.0.0.1:45871', ZEHNORA_GOOGLE_OAUTH_BASE: 'http://127.0.0.1:45871' },
  },
});
