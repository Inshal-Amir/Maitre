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

export type AttachmentKind = 'pdf' | 'docx' | 'text';

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
}

export type AttachmentResult = Attachment | { name: string; error: string };

export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  createdAt: number;
  attachments?: Attachment[];
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

export interface McpServerConfig {
  id: string;
  name: string;
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  enabled: boolean;
}

export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
  services: GoogleService[];
  /** Use Google's hosted MCP servers (Workspace Developer Preview) instead of the built-in connector. */
  official: boolean;
}

export type ConnectorState = 'connected' | 'connecting' | 'disconnected' | 'needs-auth' | 'error';

export interface ConnectorStatus {
  id: string;
  name: string;
  kind: 'google' | 'custom';
  state: ConnectorState;
  detail: string;
  tools: string[];
  account?: string;
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
  | { type: 'waiting'; conversationId: string; phase: 'compacting' | 'model' | null };

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
  pathForFile(file: File): string;
  stop(id: string): Promise<void>;
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
  saveMcpServer(config: McpServerConfig): Promise<ConnectorStatus[]>;
  removeMcpServer(id: string): Promise<ConnectorStatus[]>;
  reconnectMcpServer(id: string): Promise<ConnectorStatus[]>;
  listMemories(): Promise<Memory[]>;
  deleteMemory(id: string): Promise<void>;
  clearMemories(): Promise<void>;
  listProcesses(): Promise<ProcessInfo[]>;
  stopProcess(id: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  revealPath(target: string): Promise<void>;
  platform: NodeJS.Platform;
  onEvent(listener: (event: AgentEvent) => void): () => void;
}
