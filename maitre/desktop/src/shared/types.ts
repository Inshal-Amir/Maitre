export type Mode = 'chat' | 'work';

export type ApprovalPolicy = 'risky' | 'writes' | 'never';

export type Risk = 'safe' | 'normal' | 'risky';

export type ToolStatus = 'pending' | 'awaiting-approval' | 'awaiting-input' | 'running' | 'done' | 'error' | 'denied' | 'cancelled';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  status: ToolStatus;
  result?: string;
  summary?: string;
  risk?: Risk;
  startedAt?: number;
  endedAt?: number;
}

export type AttachmentKind = 'pdf' | 'docx' | 'text' | 'image';

export interface Attachment {
  id: string;
  name: string;
  path: string;
  size: number;
  kind: AttachmentKind;
  pages?: number;
  chars: number;
  truncated: boolean;
  /** Extracted text; kept in the main process and the saved conversation. */
  text?: string;
  /** Images only: the picture as a data URL, sent to the model and shown as a thumbnail. */
  dataUrl?: string;
}

export type AttachmentResult = Attachment | { name: string; error: string };

/** A skill or command the user called with `/name`: its instructions travel with the message. */
export interface InvokedSkill {
  name: string;
  arguments: string;
  instructions: string;
  dir?: string;
}

export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  createdAt: number;
  attachments?: Attachment[];
  skill?: InvokedSkill;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  createdAt: number;
  streaming?: boolean;
  error?: string;
  usage?: Usage;
}

export type Message = UserMessage | AssistantMessage;

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export type PlanStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  title: string;
  status: PlanStatus;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  updatedAt: number;
}

export interface Question {
  question: string;
  options?: string[];
  multiple?: boolean;
}

export interface QuestionRequest {
  id: string;
  conversationId: string;
  toolCallId: string;
  title: string;
  questions: Question[];
}

export interface ConversationSummary {
  id: string;
  mode: Mode;
  title: string;
  cwd?: string;
  /** Messages before this index were summarized to fit the context window. */
  compactedAt?: number;
  plan?: Plan;
  /** The user picked the working folder for this task (the agent must not ask where to work). */
  cwdChosen?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation extends ConversationSummary {
  messages: Message[];
  summary?: { text: string; upTo: number };
}

export interface Memory {
  id: string;
  text: string;
  createdAt: number;
}

export type GoogleService = 'gmail' | 'calendar' | 'drive' | 'docs' | 'sheets';

export const GOOGLE_SERVICES: readonly GoogleService[] = ['gmail', 'calendar', 'drive', 'docs', 'sheets'];

/** `http` is Streamable HTTP (falls back to SSE for older servers), `sse` forces the legacy SSE transport. */
export type McpTransportType = 'http' | 'sse' | 'stdio';

export interface McpServerConfig {
  id: string;
  name: string;
  type: McpTransportType;
  url?: string;
  command?: string;
  args?: string[];
  enabled: boolean;
  /** Names of environment variables (stdio) whose values are stored encrypted. */
  envKeys?: string[];
  /** Names of HTTP headers whose values are stored encrypted (e.g. Authorization). */
  headerKeys?: string[];
  /** The gallery entry this server was added from. */
  catalogId?: string;
}

/** What the UI sends to add or edit a server: values for env/headers; an empty value keeps the saved one. */
export interface McpServerInput extends McpServerConfig {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
  services: GoogleService[];
  /** Use Google's hosted MCP servers (Workspace Developer Preview) instead of the built-in connector. */
  official: boolean;
}

export type ConnectorState = 'connected' | 'connecting' | 'disconnected' | 'needs-auth' | 'error';

export type ConnectorKind = 'google' | 'custom' | 'plugin';

export interface ConnectorStatus {
  id: string;
  name: string;
  kind: ConnectorKind;
  state: ConnectorState;
  detail: string;
  tools: string[];
  account?: string;
  /** Plugin that brought this server. */
  plugin?: string;
}

export type SkillSource = 'builtin' | 'user' | 'plugin' | 'project' | 'claude';

export interface SkillInfo {
  /** Stable key used to enable or disable it, e.g. `user:pdf-tools` or `plugin:docs:pdf`. */
  id: string;
  /** What the user types after `/` and the agent passes to use_skill. */
  name: string;
  description: string;
  source: SkillSource;
  kind: 'skill' | 'command';
  plugin?: string;
  /** Folder on disk (built-in skills have none). */
  dir?: string;
  enabled: boolean;
  /** Listed for the agent to pick on its own. */
  modelInvocable: boolean;
  /** Offered in the `/` menu. */
  userInvocable: boolean;
  argumentHint?: string;
  /** Supporting files next to SKILL.md (relative paths). */
  files: string[];
  editable: boolean;
}

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
}

export interface SkillDocument extends SkillInfo {
  instructions: string;
}

export interface PluginServerInfo {
  id: string;
  name: string;
  /** `npx -y …` or the URL: shown before installing, since installing lets it run. */
  target: string;
  /** `${VAR}` placeholders not set in the environment; the user fills them in. */
  missingVars: string[];
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  /** Where it came from: a GitHub address, a marketplace entry or a folder. */
  source: string;
  marketplace?: string;
  dir: string;
  enabled: boolean;
  skills: string[];
  commands: string[];
  servers: PluginServerInfo[];
  /** Parts of Claude Code plugins Maitre does not run (hooks, agents, LSP servers). */
  ignored: string[];
  installedAt: number;
}

/** A downloaded plugin waiting for the user to review and confirm. */
export interface PluginPreview extends Omit<PluginInfo, 'enabled' | 'installedAt' | 'dir'> {
  stagingId: string;
  /** Already installed under this id: confirming updates it. */
  replaces?: string;
}

export interface MarketplacePlugin {
  name: string;
  description: string;
  category?: string;
  author?: string;
  homepage?: string;
  installed: boolean;
}

export interface MarketplaceInfo {
  id: string;
  name: string;
  source: string;
  description?: string;
  plugins: MarketplacePlugin[];
  loaded: boolean;
  updatedAt: number;
  error?: string;
}

/** What a GitHub address or folder turned out to be. */
export type InstallResult =
  | { kind: 'plugin'; preview: PluginPreview }
  | { kind: 'marketplace'; marketplace: MarketplaceInfo }
  | { kind: 'skills'; skills: SkillInfo[] };

export interface ToolInfo {
  name: string;
  description: string;
  group: string;
  modes: Mode[];
  enabled: boolean;
  /** The Work workflow depends on it, so it cannot be switched off. */
  locked: boolean;
}

export interface CommandCheck {
  command: string;
  found: boolean;
}

export interface Settings {
  apiBase: string;
  consoleBase: string;
  accountEmail: string;
  model: string;
  hasApiKey: boolean;
  hasGithubToken: boolean;
  approvalPolicy: ApprovalPolicy;
  defaultWorkDir: string;
  searxngUrl: string;
  contextTokens: number;
  maxOutputTokens: number;
  theme: 'system' | 'light' | 'dark';
  google: GoogleSettings;
  mcpServers: McpServerConfig[];
  memoryEnabled: boolean;
  /** Skill ids the user switched off. */
  disabledSkills: string[];
  /** Built-in tool names the user switched off. */
  disabledTools: string[];
  /** Also offer the skills in ~/.claude/skills (Claude Code). */
  claudeSkills: boolean;
}

export type SettingsPatch = Partial<Omit<Settings, 'hasApiKey' | 'hasGithubToken'>> & {
  apiKey?: string;
  githubToken?: string;
};

export interface ApprovalRequest {
  id: string;
  conversationId: string;
  toolCallId: string;
  tool: string;
  title: string;
  detail: string;
  cwd?: string;
  reason: string;
}

export type ApprovalDecision = 'once' | 'always' | 'deny';

export interface AccountStatus {
  email: string | null;
  credits: number | null;
}

export interface ModelStatus {
  state: 'online' | 'offline' | 'unauthorized' | 'no-key';
  detail: string;
}

export interface ProcessInfo {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid: number;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
}

export type AgentEvent =
  | { type: 'message'; conversationId: string; message: Message }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved'; id: string }
  | { type: 'question'; request: QuestionRequest }
  | { type: 'question-resolved'; id: string }
  | { type: 'run-state'; conversationId: string; running: boolean }
  | { type: 'conversation'; summary: ConversationSummary }
  | { type: 'processes'; processes: ProcessInfo[] }
  | { type: 'connectors'; connectors: ConnectorStatus[] }
  | { type: 'memories'; memories: Memory[] }
  | { type: 'skills' }
  | { type: 'plugins' }
  | { type: 'tools' }
  | { type: 'message-removed'; conversationId: string; id: string }
  | { type: 'waiting'; conversationId: string; phase: WaitPhase | null; tokens?: number; afterTools?: boolean };

export type WaitPhase = 'compacting' | 'model';

/** What a run is waiting on before the model's first token: the size of the request and whether it follows tool results. */
export interface WaitState {
  phase: WaitPhase;
  tokens?: number;
  afterTools?: boolean;
}

export interface MaitreApi {
  listConversations(): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<Conversation | null>;
  createConversation(mode: Mode, cwd?: string): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;
  renameConversation(id: string, title: string): Promise<void>;
  setWorkDir(id: string): Promise<string | null>;
  /** Sets (or with null resets to the default) the working folder of a task; returns the folder now in use. */
  setConversationFolder(id: string, dir: string | null): Promise<string>;
  send(id: string, text: string, attachmentIds?: string[]): Promise<void>;
  attachFiles(paths?: string[]): Promise<AttachmentResult[]>;
  /** A pasted image that has no file on disk (e.g. a screenshot on the clipboard). */
  attachImage(name: string, dataUrl: string): Promise<AttachmentResult>;
  pathForFile(file: File): string;
  stop(id: string): Promise<void>;
  /** Runs the last failed or stopped turn of a chat again. */
  retry(id: string): Promise<void>;
  decide(approvalId: string, decision: ApprovalDecision): Promise<void>;
  answer(questionId: string, answers: string[]): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(patch: SettingsPatch): Promise<Settings>;
  chooseDirectory(current?: string): Promise<string | null>;
  modelStatus(): Promise<ModelStatus>;
  connectAccount(email: string, password: string, create: boolean): Promise<AccountStatus>;
  accountStatus(): Promise<AccountStatus>;
  signOut(): Promise<void>;
  listConnectors(): Promise<ConnectorStatus[]>;
  connectGoogle(services: GoogleService[]): Promise<ConnectorStatus[]>;
  disconnectGoogle(): Promise<ConnectorStatus[]>;
  saveMcpServer(config: McpServerInput): Promise<ConnectorStatus[]>;
  removeMcpServer(id: string): Promise<ConnectorStatus[]>;
  reconnectMcpServer(id: string): Promise<ConnectorStatus[]>;
  /** Adds the servers in a Claude Desktop / VS Code style `mcpServers` JSON; returns how many were added. */
  importMcpJson(json: string): Promise<number>;
  checkCommands(commands: string[]): Promise<CommandCheck[]>;
  listSkills(cwd?: string): Promise<SkillInfo[]>;
  getSkill(id: string): Promise<SkillDocument | null>;
  saveSkill(draft: SkillDraft, replaceId?: string): Promise<SkillInfo>;
  deleteSkill(id: string): Promise<void>;
  setSkillEnabled(id: string, enabled: boolean): Promise<void>;
  /** Copies a skill folder (with SKILL.md) chosen in a dialog, or the given one, into the user's skills. */
  importSkillFolder(dir?: string): Promise<SkillInfo[]>;
  listTools(): Promise<ToolInfo[]>;
  setToolEnabled(name: string, enabled: boolean): Promise<void>;
  listPlugins(): Promise<PluginInfo[]>;
  /** A GitHub address (owner/repo, URL) or a local folder; folder picker when empty. */
  inspectSource(source: string): Promise<InstallResult | null>;
  inspectMarketplacePlugin(marketplaceId: string, name: string): Promise<PluginPreview>;
  confirmPlugin(stagingId: string): Promise<PluginInfo>;
  cancelPlugin(stagingId: string): Promise<void>;
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  removePlugin(id: string): Promise<void>;
  updatePlugin(id: string): Promise<PluginPreview>;
  listMarketplaces(): Promise<MarketplaceInfo[]>;
  refreshMarketplace(id: string): Promise<MarketplaceInfo>;
  removeMarketplace(id: string): Promise<void>;
  /** Values for a plugin server's `${VAR}` placeholders (stored encrypted), then reconnects it. */
  setServerVars(id: string, values: Record<string, string>): Promise<ConnectorStatus[]>;
  listMemories(): Promise<Memory[]>;
  deleteMemory(id: string): Promise<void>;
  clearMemories(): Promise<void>;
  listProcesses(): Promise<ProcessInfo[]>;
  stopProcess(id: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  revealPath(target: string): Promise<void>;
  /** Opens a document Maitre created (PDF, Word, PowerPoint, Markdown, HTML) in its default app. */
  openDocument(target: string): Promise<void>;
  platform: NodeJS.Platform;
  onEvent(listener: (event: AgentEvent) => void): () => void;
}
