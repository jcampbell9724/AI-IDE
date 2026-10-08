import { z } from "zod";

const identifier = z.string().trim().min(1).max(160);
const pathString = z.string().trim().min(1).max(4096);
const isoTimestamp = z.string().datetime({ offset: true });
const jsonRecord = z.record(z.string(), z.unknown());

export const CommandSpecSchema = z.object({
  command: z.string().trim().min(1).max(1024),
  args: z.array(z.string().max(4096)).max(128).default([]),
  cwd: pathString.optional(),
});
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

export const ProjectDetectionSchema = z.object({
  root: pathString,
  name: z.string().min(1).max(255),
  manifests: z.array(z.string().max(512)).max(100),
  runtimes: z.array(z.string().max(100)).max(20),
  frameworks: z.array(z.string().max(100)).max(30),
  packageManager: z.string().max(50).nullable(),
  scripts: z.record(z.string(), z.string().max(4096)),
  suggestedCommands: z.object({
    dev: z.string().max(4096).optional(),
    start: z.string().max(4096).optional(),
    test: z.string().max(4096).optional(),
    build: z.string().max(4096).optional(),
  }),
});
export type ProjectDetection = z.infer<typeof ProjectDetectionSchema>;

export const ProjectSelectionRequestSchema = z.object({
  path: pathString,
  // Omitted keeps a saved override; empty explicitly restores auto-detection.
  devCommand: z.string().trim().max(4096).optional(),
  url: z.string().url().max(4096).optional(),
});
export type ProjectSelectionRequest = z.infer<
  typeof ProjectSelectionRequestSchema
>;

export const ProjectRecordSchema = z.object({
  root: pathString,
  detection: ProjectDetectionSchema,
  devCommand: z.string().max(4096).nullable(),
  devCommandSource: z.enum(["detected", "custom"]).optional(),
  url: z.string().url().max(4096).nullable(),
  selectedAt: isoTimestamp,
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const ProjectStateSchema = z.object({
  current: ProjectRecordSchema.nullable(),
  recent: z.array(ProjectRecordSchema).max(1000),
  pinned: z.array(pathString).max(1000).default([]),
});
export type ProjectState = z.infer<typeof ProjectStateSchema>;

export const OpenRouterModelSchema = z.object({
  id: identifier,
  name: z.string().max(500).nullable(),
  description: z.string().max(20_000).nullable(),
  contextLength: z.number().int().nonnegative().nullable(),
  pricing: z.object({
    prompt: z.string().max(100).nullable(),
    completion: z.string().max(100).nullable(),
  }),
  supportedParameters: z.array(z.string().max(100)).max(100),
  supportsTools: z.boolean(),
  modalities: z.array(z.string().max(100)).max(20),
});
export type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;

export const ModelListResponseSchema = z.object({
  models: z.array(OpenRouterModelSchema),
  fetchedAt: isoTimestamp,
  cached: z.boolean(),
});
export type ModelListResponse = z.infer<typeof ModelListResponseSchema>;

export const BoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type Bounds = z.infer<typeof BoundsSchema>;

export const ElementLocatorSchema = z.object({
  selector: z.string().max(4096).nullable(),
  backendNodeId: z.number().int().positive().nullable(),
  frameId: z.string().max(500).nullable(),
  attributes: z.record(z.string(), z.string().max(4096)),
  text: z.string().max(4096).nullable(),
  ancestry: z.array(z.string().max(500)).max(32),
});
export type ElementLocator = z.infer<typeof ElementLocatorSchema>;

export const ElementContextSchema = z.object({
  id: identifier,
  label: z.string().min(1).max(500),
  tag: z.string().min(1).max(100),
  locator: ElementLocatorSchema,
  classes: z.array(z.string().max(500)).max(200),
  bounds: BoundsSchema,
  computedStyle: z.record(z.string(), z.string().max(4096)),
  inlineStyle: z.record(z.string(), z.string().max(4096)),
  matchedRules: z.array(z.string().max(8192)).max(200),
  outerHTMLSnippet: z.string().max(50_000),
  accessibility: jsonRecord.optional(),
});
export type ElementContext = z.infer<typeof ElementContextSchema>;

export const VisualOperationSchema = z.enum([
  "move",
  "resize",
  "spacing",
  "align",
  "reorder",
  "style",
]);
export type VisualOperation = z.infer<typeof VisualOperationSchema>;

export const VisualStyleDeltaSchema = z.record(
  z.string(),
  z.object({
    before: z.string().nullable(),
    preview: z.string().nullable(),
  }),
);
export type VisualStyleDelta = z.infer<typeof VisualStyleDeltaSchema>;

export const VisualChangeSchema = z.object({
  id: identifier,
  elementId: identifier,
  elementLabel: z.string().min(1).max(500),
  operation: VisualOperationSchema,
  before: BoundsSchema.optional(),
  after: BoundsSchema.optional(),
  styleDelta: VisualStyleDeltaSchema,
  createdAt: isoTimestamp,
});
export type VisualChange = z.infer<typeof VisualChangeSchema>;

export const ApprovalModeSchema = z.enum(["ask", "auto-safe", "deny"]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const ApprovalKindSchema = z.enum([
  "write",
  "command",
  "browser_side_effect",
]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(1_000_000),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const AgentContextSchema = z.object({
  projectRoot: pathString.optional(),
  activeTab: z
    .object({
      url: z.string().url().max(4096),
      title: z.string().max(2000),
      viewport: z
        .object({ width: z.number().int().positive(), height: z.number().int().positive() })
        .optional(),
    })
    .optional(),
  elements: z.array(ElementContextSchema).max(32).default([]),
  visualChanges: z.array(VisualChangeSchema).max(500).default([]),
  attachments: z.array(jsonRecord).max(50).default([]),
});
export type AgentContext = z.infer<typeof AgentContextSchema>;

export const AgentRunRequestSchema = z.object({
  runId: identifier,
  sessionId: identifier,
  model: identifier,
  messages: z.array(ChatMessageSchema).min(1).max(500),
  context: AgentContextSchema.default({
    elements: [],
    visualChanges: [],
    attachments: [],
  }),
  approvalMode: ApprovalModeSchema.default("ask"),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export const AgentCancelRequestSchema = z.object({ runId: identifier });
export type AgentCancelRequest = z.infer<typeof AgentCancelRequestSchema>;

export const BrowserActionSchema = z.enum([
  "context",
  "inspect_element",
  "navigate",
  "back",
  "forward",
  "refresh",
  "tabs",
  "click",
  "type",
  "key",
  "scroll",
  "hover",
  "focus",
  "wait_for",
  "screenshot",
  "console",
  "network_errors",
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

export const BrowserRequestSchema = z.object({
  id: identifier,
  runId: identifier,
  action: BrowserActionSchema,
  arguments: jsonRecord,
  createdAt: isoTimestamp,
});
export type BrowserRequest = z.infer<typeof BrowserRequestSchema>;

export const BrowserResultInputSchema = z
  .object({
    result: z.unknown().optional(),
    error: z.string().min(1).max(20_000).optional(),
  })
  .refine((value) => value.error !== undefined || value.result !== undefined, {
    message: "Either result or error is required",
  });
export type BrowserResultInput = z.infer<typeof BrowserResultInputSchema>;

export const FsListArgsSchema = z.object({
  path: z.string().max(4096).default("."),
  depth: z.number().int().min(0).max(5).default(2),
  maxEntries: z.number().int().min(1).max(2000).default(500),
});
export const FsReadArgsSchema = z.object({
  path: pathString,
  startLine: z.number().int().min(1).max(1_000_000).default(1),
  endLine: z.number().int().min(1).max(1_000_000).optional(),
  maxLines: z.number().int().min(1).max(5000).default(500),
  maxBytes: z.number().int().min(1).max(5_000_000).default(1_000_000),
});
export const FsSearchArgsSchema = z.object({
  path: z.string().max(4096).default("."),
  query: z.string().min(1).max(1000),
  regex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  extensions: z.array(z.string().max(30)).max(100).default([]),
  maxResults: z.number().int().min(1).max(1000).default(200),
});
export const FsReplaceArgsSchema = z.object({
  path: pathString,
  oldText: z.string().min(1).max(1_000_000),
  newText: z.string().max(1_000_000),
  expectedOccurrences: z.number().int().min(1).max(10_000).default(1),
});
export const FsWriteArgsSchema = z.object({
  path: pathString,
  content: z.string().max(1_000_000),
  overwrite: z.boolean().default(false),
});
export const GitDiffArgsSchema = z.object({
  staged: z.boolean().default(false),
  path: z.string().max(4096).optional(),
});
export const GitLogArgsSchema = z.object({
  maxCount: z.number().int().min(1).max(100).default(20),
});
export const ShellRunArgsSchema = z.object({
  command: z.string().trim().min(1).max(1024),
  args: z.array(z.string().max(4096)).max(128).default([]),
  cwd: z.string().max(4096).default("."),
  timeoutMs: z.number().int().min(100).max(300_000).default(60_000),
});
export const BrowserToolArgsSchema = z.object({
  action: BrowserActionSchema,
  arguments: jsonRecord.default({}),
});

export const ToolCallRequestSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("fs_list"), arguments: FsListArgsSchema }),
  z.object({ name: z.literal("fs_read"), arguments: FsReadArgsSchema }),
  z.object({ name: z.literal("fs_search"), arguments: FsSearchArgsSchema }),
  z.object({ name: z.literal("fs_replace"), arguments: FsReplaceArgsSchema }),
  z.object({ name: z.literal("fs_write"), arguments: FsWriteArgsSchema }),
  z.object({ name: z.literal("git_status"), arguments: z.object({}) }),
  z.object({ name: z.literal("git_diff"), arguments: GitDiffArgsSchema }),
  z.object({ name: z.literal("git_log"), arguments: GitLogArgsSchema }),
  z.object({ name: z.literal("shell_run"), arguments: ShellRunArgsSchema }),
  z.object({ name: z.literal("browser"), arguments: BrowserToolArgsSchema }),
]);
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

const diagnosticCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const RunDiagnosticsSchema = z.object({
  version: z.literal(1),
  policy: z.literal("repository-memory-v1"),
  requestedModel: identifier,
  memoryEnabled: z.boolean(),
  mapEnabled: z.boolean(),
  settingsChanged: z.boolean(),
  checkpointInterval: diagnosticCount,
  durationMs: diagnosticCount,
  modelRequests: diagnosticCount,
  modelResponses: diagnosticCount,
  usage: z.object({
    coverage: z.enum(["complete", "partial", "unavailable"]),
    responsesWithUsage: diagnosticCount,
    promptTokens: diagnosticCount.optional(),
    completionTokens: diagnosticCount.optional(),
    totalTokens: diagnosticCount.optional(),
    costUsd: z.number().finite().nonnegative().optional(),
  }).strict(),
  context: z.object({
    restoredBytes: diagnosticCount,
    omittedHistoryMessages: diagnosticCount,
    omittedHistoryBytes: diagnosticCount,
    resumedHandoff: z.boolean(),
  }).strict(),
  tools: z.object({
    attempted: diagnosticCount, succeeded: diagnosticCount, failed: diagnosticCount,
    mapAttempts: diagnosticCount, mapSucceeded: diagnosticCount,
    sourceReads: diagnosticCount, repeatedSourceReads: diagnosticCount,
    staleEditRejections: diagnosticCount, unreadEditRejections: diagnosticCount,
  }).strict(),
  memory: z.object({
    handoffSaves: diagnosticCount, noteSaves: diagnosticCount,
    checkpointReminders: diagnosticCount, checkpointBlockedTools: diagnosticCount,
  }).strict(),
}).strict();
export type RunDiagnostics = z.infer<typeof RunDiagnosticsSchema>;

const baseEvent = z.object({
  runId: identifier,
  timestamp: isoTimestamp,
});

export const AgentEventSchema = z.discriminatedUnion("type", [
  baseEvent.extend({ type: z.literal("run.started"), sessionId: identifier, model: identifier }),
  baseEvent.extend({ type: z.literal("assistant.thinking"), delta: z.string() }),
  baseEvent.extend({ type: z.literal("assistant.delta"), delta: z.string() }),
  baseEvent.extend({ type: z.literal("assistant.message"), content: z.string() }),
  baseEvent.extend({ type: z.literal("tool.started"), toolCallId: identifier, name: identifier, arguments: jsonRecord }),
  baseEvent.extend({ type: z.literal("tool.finished"), toolCallId: identifier, name: identifier, result: z.unknown(), error: z.string().optional() }),
  baseEvent.extend({ type: z.literal("approval.required"), approvalId: identifier, kind: ApprovalKindSchema, summary: z.string().max(20_000), details: jsonRecord }),
  baseEvent.extend({ type: z.literal("approval.resolved"), approvalId: identifier, decision: z.enum(["approve", "reject"]) }),
  baseEvent.extend({ type: z.literal("browser.request"), request: BrowserRequestSchema }),
  baseEvent.extend({
    type: z.literal("run.completed"),
    diagnostics: RunDiagnosticsSchema.optional(),
    content: z.string(),
    model: identifier.optional(),
    usage: jsonRecord.optional(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  baseEvent.extend({ type: z.literal("run.error"), diagnostics: RunDiagnosticsSchema.optional(), error: z.string().max(20_000), code: z.string().max(100).optional() }),
  baseEvent.extend({ type: z.literal("run.cancelled"), diagnostics: RunDiagnosticsSchema.optional() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const DevProcessStateSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "restarting",
  "failed",
  "stopping",
]);
export type DevProcessState = z.infer<typeof DevProcessStateSchema>;

export const DevLogEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: isoTimestamp,
  stream: z.enum(["stdout", "stderr", "system"]),
  text: z.string().max(100_000),
});
export type DevLogEntry = z.infer<typeof DevLogEntrySchema>;

export const ProjectViewSchema = z.object({
  path: pathString.nullable(),
  name: z.string().max(255).nullable(),
  url: z.string().url().max(4096).nullable(),
  devCommand: z.string().max(4096).nullable(),
  status: DevProcessStateSchema,
  pid: z.number().int().positive().nullable(),
  error: z.string().max(20_000).optional(),
  candidates: z.array(z.object({
    path: pathString,
    name: z.string().min(1).max(255),
  })).max(20).optional(),
});
export type ProjectView = z.infer<typeof ProjectViewSchema>;

export const ProjectLogsResponseSchema = z.object({
  logs: z.array(DevLogEntrySchema),
  next: z.number().int().nonnegative(),
});
export type ProjectLogsResponse = z.infer<typeof ProjectLogsResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(20_000),
    issues: z.array(jsonRecord).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
