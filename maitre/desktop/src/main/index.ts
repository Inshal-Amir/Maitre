import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, powerSaveBlocker, session, shell } from 'electron';
import type { AgentEvent, ApprovalDecision, Attachment, AttachmentResult, Conversation, GoogleService, McpServerConfig, Mode, ModelStatus, SettingsPatch } from '../shared/types';
import { initShellEnvironment, listProcesses, setExtraEnv, stopAllProcesses, stopProcess, watchProcesses } from './tools/shell';
import { getSettings, readSecret, saveSettings } from './settings';
import { configureBackups } from './tools/files';
import { protectPaths } from './tools/policy';
import { Connectors } from './mcp/connectors';
import { Runtime } from './agent/runtime';
import { checkModel } from './llm';
import * as account from './account';
import { extractDocument } from './documents';
import { clearMemories, deleteMemory, listMemories, watchMemories } from './memory';
import * as store from './store';
import { adoptOldUserData } from './legacy';

app.setName('Maitre');
if (process.env.MAITRE_USER_DATA) app.setPath('userData', process.env.MAITRE_USER_DATA);
else adoptOldUserData(app.getPath('appData'), app.getPath('userData'));

const RENDERER_DEV_URL = process.env.MAITRE_RENDERER_URL;
const RENDERER_FILE = path.join(__dirname, '../renderer/index.html');

let mainWindow: BrowserWindow | null = null;

function emit(event: AgentEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('maitre:event', event);
}

const connectors = new Connectors((statuses) => emit({ type: 'connectors', connectors: statuses }));

const runtime = new Runtime({
  settings: getSettings,
  apiKey: () => readSecret('api-key'),
  save: store.save,
  emit,
  extraTools: () => connectors.tools(),
  connectedApps: () => connectors.connectedApps(),
});

function applyGithubToken(): void {
  const token = readSecret('github-token');
  setExtraEnv(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {});
}

function recoverInterrupted(conversation: Conversation): Conversation {
  if (runtime.isRunning(conversation.id)) return conversation;
  for (const message of conversation.messages) {
    if (message.role !== 'assistant') continue;
    if (message.streaming) {
      message.streaming = false;
      message.error ??= 'Interrupted when the app closed.';
    }
    for (const call of message.toolCalls) {
      if (call.status === 'running' || call.status === 'pending' || call.status === 'awaiting-approval' || call.status === 'awaiting-input') call.status = 'cancelled';
    }
  }
  return conversation;
}

const pendingAttachments = new Map<string, Attachment>();

async function addAttachments(paths: string[]): Promise<AttachmentResult[]> {
  let chosen = paths;
  if (!chosen.length && mainWindow) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents and text', extensions: ['pdf', 'docx', 'txt', 'md', 'csv', 'json', 'html', 'xml', 'yaml', 'yml', 'log', 'py', 'js', 'ts', 'tsx', 'jsx', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sql', 'sh', 'ps1'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    chosen = result.canceled ? [] : result.filePaths;
  }
  return Promise.all(chosen.slice(0, 10).map(async (file): Promise<AttachmentResult> => {
    const name = path.basename(file);
    try {
      const extracted = await extractDocument(file);
      const attachment: Attachment = {
        id: crypto.randomUUID(), name, path: file, size: fs.statSync(file).size, kind: extracted.kind,
        pages: extracted.pages, chars: extracted.text.length, truncated: extracted.truncated, text: extracted.text,
      };
      pendingAttachments.set(attachment.id, attachment);
      const { text: _text, ...visible } = attachment;
      return visible;
    } catch (error) {
      return { name, error: (error as Error).message };
    }
  }));
}

function requireConversation(id: string): Conversation {
  const conversation = store.get(id);
  if (!conversation) throw new Error('Conversation not found');
  return conversation;
}

/** A folder the user picked: must exist, be a folder, and not be a whole disk. */
function validFolder(dir: string): string {
  const real = fs.realpathSync(path.resolve(dir));
  if (!fs.statSync(real).isDirectory()) throw new Error(`${real} is not a folder.`);
  if (real === path.parse(real).root) throw new Error('Choose a folder, not a whole disk.');
  return real;
}

async function chooseDirectory(current?: string): Promise<string | null> {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the working folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: current ?? getSettings().defaultWorkDir,
  });
  return result.canceled || !result.filePaths[0] ? null : fs.realpathSync(result.filePaths[0]);
}

async function modelStatus(): Promise<ModelStatus> {
  const { apiBase, model } = getSettings();
  const key = readSecret('api-key');
  if (!key) return { state: 'no-key', detail: 'Sign in to connect' };
  const { status, models } = await checkModel(apiBase, key);
  if (status === 200) return { state: 'online', detail: models.includes(model) ? model : `${model} not listed (${models.join(', ') || 'no models'})` };
  if (status === 401 || status === 403) return { state: 'unauthorized', detail: 'The API key was rejected' };
  if (status === 530 || status === 502 || status === 503) return { state: 'offline', detail: 'The Maitre server is offline right now' };
  return { state: 'offline', detail: status ? `HTTP ${status}` : 'Cannot reach the model API' };
}

function registerIpc(): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event, ...args) => fn(...(args as A)));
  };
  handle('conversations:list', () => store.list());
  handle('conversations:get', (id: string) => {
    const conversation = store.get(id);
    return conversation ? recoverInterrupted(conversation) : null;
  });
  handle('conversations:create', (mode: Mode, cwd?: string) => {
    if (mode !== 'work') return store.create(mode);
    return cwd ? store.create(mode, validFolder(cwd), true) : store.create(mode, getSettings().defaultWorkDir);
  });
  handle('conversations:set-folder', (id: string, dir: string | null) => {
    const conversation = requireConversation(id);
    conversation.cwd = dir ? validFolder(dir) : getSettings().defaultWorkDir;
    conversation.cwdChosen = Boolean(dir);
    store.save(conversation);
    emit({ type: 'conversation', summary: store.summarize(conversation) });
    return conversation.cwd;
  });
  handle('conversations:delete', (id: string) => {
    runtime.stop(id);
    runtime.approvals.forget(id);
    store.remove(id);
  });
  handle('conversations:rename', (id: string, title: string) => {
    const conversation = requireConversation(id);
    conversation.title = title.trim().slice(0, 120) || conversation.title;
    store.save(conversation);
    emit({ type: 'conversation', summary: store.summarize(conversation) });
  });
  handle('conversations:set-cwd', async (id: string) => {
    const conversation = requireConversation(id);
    const dir = await chooseDirectory(conversation.cwd);
    if (!dir) return null;
    conversation.cwd = dir;
    conversation.cwdChosen = true;
    store.save(conversation);
    emit({ type: 'conversation', summary: store.summarize(conversation) });
    return dir;
  });
  handle('attachments:add', (paths: string[]) => addAttachments(paths));
  handle('agent:send', (id: string, text: string, attachmentIds: string[]) => {
    const conversation = requireConversation(id);
    const attachments = attachmentIds.map((attachmentId) => pendingAttachments.get(attachmentId)).filter((entry): entry is Attachment => Boolean(entry));
    attachmentIds.forEach((attachmentId) => pendingAttachments.delete(attachmentId));
    const trimmed = text.trim() || (attachments.length ? 'Please look at the attached file(s).' : '');
    if (!trimmed) return;
    runtime.send(conversation, trimmed, attachments).catch((error: Error) => console.error('[maitre] run failed', error));
  });
  handle('agent:stop', (id: string) => runtime.stop(id));
  handle('agent:decide', (id: string, decision: ApprovalDecision) => runtime.approvals.decide(id, decision));
  handle('agent:answer', (id: string, answers: string[]) => runtime.questions.answer(id, answers));
  handle('settings:get', () => getSettings());
  handle('settings:save', (patch: SettingsPatch) => {
    const next = saveSettings(patch);
    applyGithubToken();
    nativeTheme.themeSource = next.theme;
    return next;
  });
  handle('dialog:directory', (current?: string) => chooseDirectory(current));
  handle('model:status', () => modelStatus());
  handle('account:connect', (email: string, password: string, create: boolean) => account.connect(email, password, create));
  handle('account:status', () => account.status());
  handle('account:sign-out', () => account.signOut());
  handle('connectors:list', () => connectors.statuses());
  handle('connectors:google-connect', (services: GoogleService[]) => connectors.connectGoogle(services));
  handle('connectors:google-disconnect', () => connectors.disconnectGoogle());
  handle('connectors:save', (config: McpServerConfig) => connectors.saveServer(config));
  handle('connectors:remove', (id: string) => connectors.removeServer(id));
  handle('connectors:reconnect', (id: string) => connectors.reconnect(id));
  handle('memories:list', () => listMemories());
  handle('memories:delete', (id: string) => {
    deleteMemory(id);
  });
  handle('memories:clear', () => clearMemories());
  handle('processes:list', () => listProcesses());
  handle('processes:stop', (id: string) => {
    stopProcess(id);
  });
  handle('shell:open-external', (url: string) => (/^https?:\/\//i.test(url) ? shell.openExternal(url) : undefined));
  handle('shell:reveal', (target: string) => shell.showItemInFolder(target));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: 'Maitre',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161616' : '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = RENDERER_DEV_URL ? url.startsWith(RENDERER_DEV_URL) : url.startsWith('file://');
    if (allowed) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  if (RENDERER_DEV_URL) mainWindow.loadURL(RENDERER_DEV_URL);
  else mainWindow.loadFile(RENDERER_FILE);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  nativeTheme.themeSource = getSettings().theme;
  const userData = app.getPath('userData');
  protectPaths([userData]);
  configureBackups(path.join(userData, 'backups'));
  applyGithubToken();
  watchProcesses((processes) => emit({ type: 'processes', processes }));
  watchMemories((memories) => emit({ type: 'memories', memories }));
  registerIpc();
  createWindow();
  powerSaveBlocker.start('prevent-app-suspension');
  await initShellEnvironment();
  connectors.start().catch((error: Error) => console.error('[maitre] connectors failed to start', error));
});

/** Dock click or `open` on a running app: bring back the window (macOS keeps the app alive after the window closes). */
function showWindow(): void {
  if (!app.isReady()) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

app.on('activate', showWindow);

app.on('before-quit', () => {
  runtime.stopAll();
  stopAllProcesses();
  connectors.manager.closeAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
