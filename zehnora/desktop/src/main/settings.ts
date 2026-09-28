import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type { Settings, SettingsPatch } from '../shared/types';

type StoredSettings = Omit<Settings, 'hasApiKey' | 'hasGithubToken'>;
export type SecretName = 'api-key' | 'github-token' | 'session' | 'google' | `mcp-${string}`;

interface GoogleClientFile {
  installed?: { client_id: string; client_secret?: string };
  web?: { client_id: string; client_secret?: string };
  client_id?: string;
  client_secret?: string;
}

/** The owner's Google OAuth client, packed into the installer from build-config/google-oauth.json (the file Google Cloud downloads). */
function bundledGoogleClient(): { clientId: string; clientSecret: string } {
  const candidates = [path.join(process.resourcesPath ?? '', 'google-oauth.json'), path.join(__dirname, '../../build-config/google-oauth.json')];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as GoogleClientFile;
      const entry = parsed.installed ?? parsed.web ?? parsed;
      if (entry.client_id) return { clientId: entry.client_id, clientSecret: entry.client_secret ?? '' };
    } catch {
      /* not bundled */
    }
  }
  return { clientId: process.env.ZEHNORA_GOOGLE_CLIENT_ID ?? '', clientSecret: process.env.ZEHNORA_GOOGLE_CLIENT_SECRET ?? '' };
}

const DEFAULTS: StoredSettings = {
  apiBase: process.env.ZEHNORA_API_BASE ?? 'https://api.dubg.dev/v1',
  consoleBase: process.env.ZEHNORA_CONSOLE_BASE ?? 'https://console.dubg.dev',
  accountEmail: '',
  model: process.env.ZEHNORA_MODEL ?? 'zehnora-coder',
  approvalPolicy: 'risky',
  defaultWorkDir: path.join(os.homedir(), 'Zehnora'),
  searxngUrl: '',
  contextTokens: 60_000,
  maxOutputTokens: 8192,
  theme: 'system',
  google: {
    ...bundledGoogleClient(),
    services: ['gmail', 'calendar', 'drive', 'docs', 'sheets'],
    official: false,
  },
  mcpServers: [],
  memoryEnabled: true,
};

const ENV_SECRETS: Partial<Record<SecretName, string>> = {
  'api-key': process.env.ZEHNORA_API_KEY,
  'github-token': process.env.ZEHNORA_GITHUB_TOKEN,
};

const settingsFile = (): string => path.join(app.getPath('userData'), 'settings.json');
const secretFile = (name: SecretName): string => path.join(app.getPath('userData'), 'secrets', `${name.replace(/[^a-z0-9-]/gi, '_')}.bin`);

let cache: StoredSettings | null = null;

function load(): StoredSettings {
  if (cache) return cache;
  try {
    const stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<StoredSettings>;
    const google = { ...DEFAULTS.google, ...stored.google };
    if (!google.clientId) ({ clientId: google.clientId, clientSecret: google.clientSecret } = DEFAULTS.google);
    cache = { ...DEFAULTS, ...stored, google };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache as StoredSettings;
}

export function readSecret(name: SecretName): string | null {
  const fromEnv = ENV_SECRETS[name];
  if (fromEnv) return fromEnv;
  const file = secretFile(name);
  if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(fs.readFileSync(file));
  } catch {
    return null;
  }
}

export function writeSecret(name: SecretName, value: string): void {
  const file = secretFile(name);
  if (!value) {
    fs.rmSync(file, { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available, so the secret cannot be stored safely.');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, safeStorage.encryptString(value), { mode: 0o600 });
}

export function getSettings(): Settings {
  return { ...load(), hasApiKey: Boolean(readSecret('api-key')), hasGithubToken: Boolean(readSecret('github-token')) };
}

const clampInt = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)));

export function saveSettings(patch: SettingsPatch): Settings {
  const { apiKey, githubToken, ...rest } = patch;
  if (apiKey !== undefined) {
    const key = apiKey.trim();
    if (key && !/^sk-[A-Za-z0-9_-]{16,}$/.test(key)) throw new Error('That does not look like a Zehnora API key (sk-…).');
    writeSecret('api-key', key);
  }
  if (githubToken !== undefined) writeSecret('github-token', githubToken.trim());
  const next: StoredSettings = { ...load(), ...rest };
  next.apiBase = next.apiBase.trim().replace(/\/+$/, '');
  next.consoleBase = next.consoleBase.trim().replace(/\/+$/, '');
  next.contextTokens = clampInt(next.contextTokens, 8000, 1_000_000);
  next.maxOutputTokens = clampInt(next.maxOutputTokens, 256, 131_072);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  cache = next;
  return getSettings();
}
