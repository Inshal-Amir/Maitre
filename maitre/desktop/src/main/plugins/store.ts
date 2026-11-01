import fs from 'node:fs';
import path from 'node:path';
import type { PluginServerSpec } from './manifest';
import { maitreHome } from '../home';

/** How to fetch a plugin again for updates. */
export type PluginOrigin =
  | { kind: 'github'; input: string }
  | { kind: 'folder'; path: string }
  | { kind: 'marketplace'; marketplace: string; name: string };

export interface InstalledPlugin {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  source: string;
  origin: PluginOrigin;
  marketplace?: string;
  enabled: boolean;
  ignored: string[];
  installedAt: number;
  /** Resolved at install time, relative to the plugin folder. */
  skillDirs: string[];
  commandFiles: string[];
  servers: Record<string, PluginServerSpec>;
}

export const pluginsRoot = (): string => path.join(maitreHome(), 'plugins');
export const pluginDir = (id: string): string => path.join(pluginsRoot(), id);
const registryFile = (): string => path.join(pluginsRoot(), 'installed.json');

export function readInstalled(): InstalledPlugin[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile(), 'utf8')) as InstalledPlugin[];
    return Array.isArray(parsed) ? parsed.filter((entry) => fs.existsSync(pluginDir(entry.id))) : [];
  } catch {
    return [];
  }
}

export function writeInstalled(plugins: InstalledPlugin[]): void {
  fs.mkdirSync(pluginsRoot(), { recursive: true });
  const temp = `${registryFile()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(plugins, null, 2));
  fs.renameSync(temp, registryFile());
}

/** Plugins whose skills, commands and servers are active. */
export const enabledPlugins = (): InstalledPlugin[] => readInstalled().filter((entry) => entry.enabled);
