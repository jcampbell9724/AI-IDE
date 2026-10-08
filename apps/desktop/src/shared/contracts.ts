import type {
  AgentEvent,
  AgentRunRequest,
  ApprovalMode,
  DevLogEntry,
  ModelListResponse,
  ProjectDetection,
} from "@browser-agent/shared";

export interface DesktopPreferences {
  readonly apiKeyConfigured: boolean;
  readonly selectedModel: string;
  readonly approvalMode: ApprovalMode;
  readonly launchAtLogin: boolean;
  readonly codebaseMapEnabled: boolean;
  readonly repositoryMemoryEnabled: boolean;
  readonly secureStorageAvailable: boolean;
  readonly secureStorageBackend: string;
}

export interface PreviewStartupState {
  readonly phase: "idle" | "starting" | "waiting" | "ready" | "needs-url" | "failed";
  readonly url?: string;
  readonly message?: string;
}

export interface DesktopProject {
  readonly path: string | null;
  readonly name: string | null;
  readonly url: string | null;
  readonly devCommand: string | null;
  readonly detection: ProjectDetection | null;
  readonly devCommandSource?: "detected" | "custom";
  readonly status: "stopped" | "starting" | "running" | "restarting" | "stopping" | "failed";
  readonly pid: number | null;
  readonly previewStartup?: PreviewStartupState;
  readonly error?: string;
}

export interface DesktopRecentProject {
  readonly path: string;
  readonly name: string;
  readonly devCommand: string | null;
  readonly url: string | null;
  readonly pinned: boolean;
}

export interface DesktopProjectEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly depth: number;
  readonly size?: number;
}

export interface DesktopProjectDirectory {
  readonly rootName: string;
  readonly entries: readonly DesktopProjectEntry[];
  readonly truncated: boolean;
}

export interface DesktopProjectFile {
  readonly path: string;
  readonly projectRoot: string;
  readonly revision: string;
  readonly content: string;
  readonly lineEnding: "LF" | "CRLF" | "mixed";
  readonly size: number;
  readonly totalLines: number;
  readonly truncated: boolean;
  readonly comparison?: { readonly content: string; readonly label: string };
  readonly comparisonError?: string;
}

export interface SaveProjectFileInput {
  readonly path: string;
  readonly projectRoot: string;
  readonly content: string;
  readonly revision: string;
}

export interface DesktopBrowserState {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly visible: boolean;
  readonly error?: string;
}

export interface DesktopSnapshot {
  readonly version: string;
  readonly preferences: DesktopPreferences;
  readonly project: DesktopProject;
  readonly recentProjects: readonly DesktopRecentProject[];
  readonly browser: DesktopBrowserState;
}

export interface SavePreferencesInput {
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
  readonly selectedModel?: string;
  readonly approvalMode?: ApprovalMode;
  readonly launchAtLogin?: boolean;
  readonly codebaseMapEnabled?: boolean;
  readonly repositoryMemoryEnabled?: boolean;
}

export interface SelectProjectInput {
  readonly path?: string;
  readonly devCommand?: string;
  readonly url?: string;
}

export interface CreateProjectInput {
  readonly name: string;
}

export interface BrowserBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
}

export interface DesktopApi {
  copyText(text: string): Promise<void>;
  getSnapshot(): Promise<DesktopSnapshot>;
  savePreferences(input: SavePreferencesInput): Promise<DesktopSnapshot>;
  chooseProject(): Promise<DesktopProject>;
  createProject(input: CreateProjectInput): Promise<DesktopProject>;
  selectProject(input: SelectProjectInput): Promise<DesktopProject>;
  removeRecentProject(path: string): Promise<DesktopSnapshot>;
  setProjectPinned(path: string, pinned: boolean): Promise<DesktopSnapshot>;
  projectAction(action: "start" | "stop" | "restart"): Promise<DesktopProject>;
  getProjectLogs(after: number): Promise<{ logs: DevLogEntry[]; next: number }>;
  listProjectDirectory(): Promise<DesktopProjectDirectory>;
  readProjectFile(path: string): Promise<DesktopProjectFile>;
  saveProjectFile(input: SaveProjectFileInput): Promise<DesktopProjectFile>;
  listModels(refresh?: boolean): Promise<ModelListResponse>;
  navigate(url: string): Promise<DesktopBrowserState>;
  browserAction(action: "back" | "forward" | "reload"): Promise<DesktopBrowserState>;
  pickElement(): Promise<{ url: string; selector: string; tagName: string; text: string } | null>;
  cancelElementPicker(): Promise<void>;
  setBrowserBounds(bounds: BrowserBounds): Promise<void>;
  runAgent(request: AgentRunRequest): Promise<{ accepted: true }>;
  cancelAgent(runId: string): Promise<{ cancelled: boolean }>;
  decideApproval(id: string, decision: "approve" | "reject"): Promise<{ resolved: boolean }>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void;
}

declare global {
  interface Window {
    browserAgent: DesktopApi;
  }
}
