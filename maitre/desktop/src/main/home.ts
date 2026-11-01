import os from 'node:os';
import path from 'node:path';

/** `~/.maitre`: user skills and installed plugins live here, outside the app's protected data folder, so their scripts can run. */
export const maitreHome = (): string => process.env.MAITRE_HOME ?? path.join(os.homedir(), '.maitre');

/** `~/.claude`: Claude Code's folder, whose skills Maitre can offer too. */
export const claudeHome = (): string => process.env.MAITRE_CLAUDE_HOME ?? path.join(os.homedir(), '.claude');
