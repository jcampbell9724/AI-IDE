import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  ToolCallRequestSchema,
  type AgentEvent,
  type AgentRunRequest,
  type ToolCallRequest,
} from "@browser-agent/shared";
import { ApprovalManager } from "./approval-manager.js";
import { AGENT_TOOLS } from "./agent-tools.js";
import { BrowserBridge } from "./browser-bridge.js";
import {
  CODEBASE_MAP_TOOL,
  type CodebaseMapFeature,
} from "./codebase-map/index.js";
import { runBoundedCommand } from "./command.js";
import { AppError } from "./errors.js";
import { FileTools } from "./fs-tools.js";
import { GitTools } from "./git-tools.js";
import type { OpenRouterToolDefinition } from "./openrouter.js";
import type { WorkspaceGuard } from "./workspace-guard.js";
import { buildWriteApprovalDetails } from "./write-preview.js";

const BROWSER_SIDE_EFFECTS = new Set([
  "navigate",
  "back",
  "forward",
  "refresh",
  "click",
  "type",
  "key",
  "scroll",
  "hover",
  "focus",
]);

export interface ToolExecutionContext {
  readonly run: AgentRunRequest;
  readonly emit: (event: AgentEvent) => void;
  readonly signal: AbortSignal;
  readonly codebaseMapEnabled: boolean;
  readonly workspace: WorkspaceGuard;
  readonly sourceReads?: Map<string, string>;
}

export class ToolExecutor {
  constructor(
    private readonly approvals: ApprovalManager,
    private readonly browser: BrowserBridge,
    private readonly codebaseMap?: CodebaseMapFeature,
  ) {}

  get codebaseMapEnabled(): boolean {
    return this.codebaseMap?.enabled ?? false;
  }

  get codebaseMapSettingsVersion(): number {
    return this.codebaseMap?.settingsVersion ?? 0;
  }

  definitions(codebaseMapEnabled = this.codebaseMapEnabled): OpenRouterToolDefinition[] {
    return codebaseMapEnabled ? [...AGENT_TOOLS, CODEBASE_MAP_TOOL] : AGENT_TOOLS;
  }

  async execute(
    name: string,
    rawArguments: unknown,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    if (name === CODEBASE_MAP_TOOL.function.name) {
      if (!context.codebaseMapEnabled || !this.codebaseMap) {
        throw new AppError("CODEBASE_MAP_DISABLED", "Codebase mapping is disabled in Settings.", 409);
      }
      const guard = context.workspace;
      return this.codebaseMap.execute(rawArguments, guard.root, context.signal);
    }
    const call = ToolCallRequestSchema.parse({ name, arguments: rawArguments });
    const guard = context.workspace;
    const files = new FileTools(guard);
    const git = new GitTools(guard);

    switch (call.name) {
      case "fs_list":
        return files.list(call.arguments, context.signal);
      case "fs_read": {
        const result = await files.read(call.arguments, context.signal) as { path: string; contentHash: string };
        const path = await guard.resolvePath(call.arguments.path, { mustExist: true });
        context.sourceReads?.set(path, result.contentHash);
        return result;
      }
      case "fs_search":
        return files.search(call.arguments, context.signal);
      case "fs_replace": {
          const expectedHash = await this.expectedSourceHash(call.arguments.path, context, true);
          await this.approveWrite(call, context, guard);
          const result = await files.replace(call.arguments, context.signal, expectedHash ?? undefined);
          context.sourceReads?.delete(await guard.resolvePath(call.arguments.path));
          this.codebaseMap?.invalidate(guard.root);
          return result;
        }
      case "fs_write": {
          const expectedHash = call.arguments.overwrite
            ? await this.expectedSourceHash(call.arguments.path, context, false) : undefined;
          await this.approveWrite(call, context, guard);
          // An absent target stays create-only across the approval boundary.
          const writeArguments = expectedHash === null ? { ...call.arguments, overwrite: false } : call.arguments;
          const result = await files.write(writeArguments, context.signal, expectedHash ?? undefined);
          context.sourceReads?.delete(await guard.resolvePath(call.arguments.path));
          this.codebaseMap?.invalidate(guard.root);
          return result;
        }
      case "git_status":
        return git.status(context.signal);
      case "git_diff":
        return git.diff(call.arguments, context.signal);
      case "git_log":
        return git.log(call.arguments, context.signal);
      case "shell_run":
        await this.approvals.require({
          runId: context.run.runId,
          kind: "command",
          summary: `Run ${call.arguments.command} ${call.arguments.args.join(" ")}`.trim(),
          details: {
            command: call.arguments.command,
            args: call.arguments.args,
            cwd: call.arguments.cwd,
          },
          mode: context.run.approvalMode,
          emit: context.emit,
          signal: context.signal,
        });
        {
          context.sourceReads?.clear();
          const result = await runBoundedCommand(guard, call.arguments, context.signal);
          this.codebaseMap?.invalidate(guard.root);
          return result;
        }
      case "browser":
        if (BROWSER_SIDE_EFFECTS.has(call.arguments.action)) {
          await this.approvals.require({
            runId: context.run.runId,
            kind: "browser_side_effect",
            summary: `Browser action: ${call.arguments.action}`,
            details: { action: call.arguments.action, arguments: call.arguments.arguments },
            mode: context.run.approvalMode,
            emit: context.emit,
            signal: context.signal,
          });
        }
        return this.browser.request({
          runId: context.run.runId,
          action: call.arguments.action,
          arguments: call.arguments.arguments,
          emit: context.emit,
          signal: context.signal,
        });
    }
  }

  private async expectedSourceHash(path: string, context: ToolExecutionContext, mustExist: boolean): Promise<string | null | undefined> {
    if (!context.sourceReads) return undefined;
    const resolved = await context.workspace.resolvePath(path, { mustExist });
    if (!mustExist) {
      try { await stat(resolved); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    }
    const hash = context.sourceReads.get(resolved);
    if (!hash) throw new AppError("SOURCE_READ_REQUIRED", "Read this file with fs_read before editing it while repository memory is enabled.", 409);
    const info = await stat(resolved);
    if (!info.isFile() || info.size > 5_000_000) throw new AppError("INVALID_WRITE_TARGET", "Edit target must be a file no larger than 5 MB");
    if (createHash("sha256").update(await readFile(resolved)).digest("hex") !== hash) {
      throw new AppError("SOURCE_CHANGED", "The file changed after it was read. Read the current source and retry the edit.", 409);
    }
    return hash;
  }

  private async approveWrite(
    call: Extract<ToolCallRequest, { name: "fs_replace" | "fs_write" }>,
    context: ToolExecutionContext,
    guard: WorkspaceGuard,
  ): Promise<void> {
    let details: Record<string, unknown>;
    try {
      const resolved = await guard.resolvePath(call.arguments.path, {
        mustExist: call.name === "fs_replace",
      });
      let before: string | null = null;
      try {
        const info = await stat(resolved);
        if (info.isFile() && info.size <= 1_000_000) {
          before = await readFile(resolved, "utf8");
        }
      } catch {
        before = null;
      }
      details = buildWriteApprovalDetails({
        path: call.arguments.path,
        operation: call.name,
        before,
        ...(call.name === "fs_replace"
          ? { fsReplace: { oldText: call.arguments.oldText, newText: call.arguments.newText } }
          : {}),
        ...(call.name === "fs_write"
          ? { fsWrite: { content: call.arguments.content, overwrite: call.arguments.overwrite } }
          : {}),
      });
    } catch {
      // The preview is a convenience; a failed preview must never block approval.
      details = { path: call.arguments.path, operation: call.name };
    }
    return this.approvals.require({
      runId: context.run.runId,
      kind: "write",
      summary: `${call.name === "fs_replace" ? "Replace text in" : "Write"} ${call.arguments.path}`,
      details,
      mode: context.run.approvalMode,
      emit: context.emit,
      signal: context.signal,
    });
  }
}
