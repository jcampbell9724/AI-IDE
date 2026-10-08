import type { RunDiagnostics } from "@browser-agent/shared";

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function sum(a: number | undefined, b: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, (a ?? 0) + b);
}

/** Counts only: prompts, source, tool arguments and paths never enter reports. */
export class RunDiagnosticsCollector {
  private readonly startedAt = Date.now();
  private readonly readPaths = new Set<string>();
  private costResponses = 0;
  private costTotal = 0;
  private pendingUsage: Record<string, number> | undefined;
  private readonly data: RunDiagnostics;

  constructor(options: { requestedModel: string; memoryEnabled: boolean; mapEnabled: boolean; checkpointInterval: number }) {
    this.data = {
      version: 1, policy: "repository-memory-v1", ...options,
      settingsChanged: false, durationMs: 0, modelRequests: 0, modelResponses: 0,
      usage: { coverage: "unavailable", responsesWithUsage: 0 },
      context: { restoredBytes: 0, omittedHistoryMessages: 0, omittedHistoryBytes: 0, resumedHandoff: false },
      tools: { attempted: 0, succeeded: 0, failed: 0, mapAttempts: 0, mapSucceeded: 0,
        sourceReads: 0, repeatedSourceReads: 0, staleEditRejections: 0, unreadEditRejections: 0 },
      memory: { handoffSaves: 0, noteSaves: 0, checkpointReminders: 0, checkpointBlockedTools: 0 },
    };
  }

  setContext(context: RunDiagnostics["context"]): void { this.data.context = { ...context }; }
  observeSettings(memoryEnabled: boolean, mapEnabled: boolean, versionChanged = false): void {
    if (versionChanged || memoryEnabled !== this.data.memoryEnabled || mapEnabled !== this.data.mapEnabled) this.data.settingsChanged = true;
  }
  modelRequested(): void {
    this.data.modelRequests += 1;
    this.pendingUsage = undefined;
  }
  modelUsage(rawUsage: unknown): void {
    const raw = record(rawUsage);
    const input = count(raw.prompt_tokens) ?? count(raw.input_tokens);
    const output = count(raw.completion_tokens) ?? count(raw.output_tokens);
    const total = count(raw.total_tokens);
    const cost = typeof raw.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : undefined;
    if (input === undefined && output === undefined && total === undefined && cost === undefined) return;
    this.pendingUsage ??= {};
    // Updates are cumulative for this request. Keep the latest counters instead
    // of counting streamed snapshots as separate model responses.
    if (total === undefined && (input !== undefined || output !== undefined)) delete this.pendingUsage.total_tokens;
    if (input !== undefined) this.pendingUsage.prompt_tokens = input;
    if (output !== undefined) this.pendingUsage.completion_tokens = output;
    if (total !== undefined) this.pendingUsage.total_tokens = total;
    if (cost !== undefined) this.pendingUsage.cost = cost;
  }
  modelResponded(rawUsage: unknown): void {
    this.data.modelResponses += 1;
    this.modelUsage(rawUsage);
    const usage = this.pendingUsage ?? {};
    this.addUsage(this.data.usage, usage);
    if (usage.prompt_tokens !== undefined && usage.completion_tokens !== undefined) this.data.usage.responsesWithUsage += 1;
    if (usage.cost !== undefined) {
      this.costResponses += 1;
      this.costTotal = Math.min(Number.MAX_SAFE_INTEGER, this.costTotal + usage.cost);
    }
    this.pendingUsage = undefined;
  }
  private addUsage(target: RunDiagnostics["usage"], usage: Record<string, number>): void {
    const input = usage.prompt_tokens;
    const output = usage.completion_tokens;
    const total = usage.total_tokens ?? (input !== undefined && output !== undefined ? sum(input, output) : undefined);
    if (input !== undefined) target.promptTokens = sum(target.promptTokens, input);
    if (output !== undefined) target.completionTokens = sum(target.completionTokens, output);
    if (total !== undefined) target.totalTokens = sum(target.totalTokens, total);
  }

  toolAttempted(name: string): void {
    this.data.tools.attempted += 1;
    if (name === "codebase_map") this.data.tools.mapAttempts += 1;
  }
  toolSucceeded(name: string, result: unknown): void {
    this.data.tools.succeeded += 1;
    if (name === "codebase_map") this.data.tools.mapSucceeded += 1;
    const data = record(result);
    if (name === "fs_read") {
      this.data.tools.sourceReads += 1;
      if (typeof data.path === "string") {
        // FileTools returns the canonical project-relative path. Only keep it in
        // this short-lived collector to count repeated reads; never export it.
        if (this.readPaths.has(data.path)) this.data.tools.repeatedSourceReads += 1;
        else this.readPaths.add(data.path);
      }
    }
    if (name === "repository_memory" && data.saved === true) {
      if (data.action === "save_handoff") this.data.memory.handoffSaves += 1;
      if (data.action === "save_project_note") this.data.memory.noteSaves += 1;
    }
  }
  toolFailed(error: unknown): void {
    this.data.tools.failed += 1;
    const code = record(error).code;
    if (code === "SOURCE_CHANGED") this.data.tools.staleEditRejections += 1;
    if (code === "SOURCE_READ_REQUIRED") this.data.tools.unreadEditRejections += 1;
    if (code === "MEMORY_CHECKPOINT_REQUIRED") this.data.memory.checkpointBlockedTools += 1;
  }
  checkpointReminder(): void { this.data.memory.checkpointReminders += 1; }

  snapshot(): RunDiagnostics {
    const report = structuredClone(this.data);
    report.durationMs = Math.max(0, Date.now() - this.startedAt);
    if (this.pendingUsage) this.addUsage(report.usage, this.pendingUsage);
    const anyTokens = report.usage.promptTokens !== undefined || report.usage.completionTokens !== undefined || report.usage.totalTokens !== undefined;
    report.usage.coverage = report.modelRequests > 0 && report.usage.responsesWithUsage === report.modelRequests
      ? "complete" : anyTokens ? "partial" : "unavailable";
    // Partial cost reporting cannot be mistaken for a full-run bill.
    if (report.modelRequests > 0 && this.costResponses === report.modelRequests) report.usage.costUsd = this.costTotal;
    return report;
  }
}
