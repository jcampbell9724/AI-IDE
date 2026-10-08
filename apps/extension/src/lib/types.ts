export type ApprovalMode = "ask" | "auto-safe" | "deny";

export interface ExtensionSettings {
  daemonUrl: string;
  token: string;
  approvalMode: ApprovalMode;
  selectedModel: string;
  favoriteModels: string[];
  cdpEnabled: boolean;
}

export interface ModelInfo {
  id: string;
  name?: string | null;
  provider?: string;
  contextLength?: number | null;
  description?: string | null;
  supportedParameters?: string[];
  supportsTools?: boolean;
  modalities?: string[];
}

export interface ProjectInfo {
  id?: string;
  path?: string;
  name?: string;
  url?: string;
  devCommand?: string;
  status: "unknown" | "stopped" | "starting" | "running" | "restarting" | "stopping" | "failed" | "error";
  pid?: number;
  candidates?: Array<{ path: string; name?: string }>;
  error?: string;
}

export interface ProjectLog {
  seq: number;
  stream?: "stdout" | "stderr" | "system";
  text: string;
  timestamp?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ElementContext {
  id: string;
  selector: string;
  tagName: string;
  text: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  computedStyles: Record<string, string>;
  inlineStyles: Record<string, string>;
  outerHTMLSnippet: string;
  pageUrl: string;
}

export interface EditDelta {
  id: string;
  selector: string;
  property: string;
  value: string;
  previousValue: string;
  timestamp: number;
}

export type ToolStatus = "running" | "approval" | "completed" | "error" | "rejected";

export interface ToolTimelineItem {
  id: string;
  name: string;
  status: ToolStatus;
  summary?: string;
  approvalId?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface BrowserRequest {
  id: string;
  runId?: string;
  action?: string;
  arguments?: Record<string, unknown>;
  createdAt?: string;
  command?: string;
  params?: Record<string, unknown>;
}

export interface AgentEvent {
  type:
    | "run.started"
    | "assistant.message"
    | "assistant.delta"
    | "tool.started"
    | "tool.finished"
    | "approval.required"
    | "approval.resolved"
    | "browser.request"
    | "run.completed"
    | "run.error"
    | "run.cancelled";
  runId?: string;
  message?: string;
  content?: string;
  delta?: string;
  toolId?: string;
  tool?: string;
  toolCallId?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  details?: Record<string, unknown>;
  kind?: string;
  summary?: string;
  error?: string;
  approvalId?: string;
  decision?: "approve" | "reject";
  request?: BrowserRequest;
  discardPreview?: boolean;
  result?: unknown;
  [key: string]: unknown;
}

export interface AgentRunRequest {
  runId: string;
  sessionId: string;
  model: string;
  messages: Array<{ role: ChatMessage["role"]; content: string }>;
  context: Record<string, unknown>;
  approvalMode: ApprovalMode;
}

export interface ContentEvent {
  type: "selection.added" | "selection.removed" | "selection.cleared" | "picker.stopped" | "preview.changed";
  element?: ElementContext;
  elementId?: string;
  deltas?: EditDelta[];
}
