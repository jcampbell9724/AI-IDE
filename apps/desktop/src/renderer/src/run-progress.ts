import type { AgentEvent } from "@browser-agent/shared";

export type RunPhase =
  | "idle"
  | "starting"
  | "thinking"
  | "streaming"
  | "tool"
  | "approval"
  | "stopping"
  | "completed"
  | "cancelled"
  | "error";

export interface RunProgress {
  phase: RunPhase;
  label: string;
  detail: string;
  startedAt: number | null;
  durationMs: number | null;
}

export const IDLE_RUN_PROGRESS: RunProgress = {
  phase: "idle",
  label: "",
  detail: "",
  startedAt: null,
  durationMs: null,
};

export function beginRunProgress(model: string, now = Date.now()): RunProgress {
  return {
    phase: "starting",
    label: "Starting the agent…",
    detail: model,
    startedAt: now,
    durationMs: null,
  };
}

export function progressFromEvent(current: RunProgress, event: AgentEvent, now = Date.now()): RunProgress {
  const startedAt = current.startedAt ?? timestampMs(event.timestamp) ?? now;
  if (current.phase === "stopping" && !isTerminalEvent(event)) return current;
  switch (event.type) {
    case "run.started":
      return activeProgress("starting", "Connected. Waiting for the model…", event.model, startedAt);
    case "assistant.thinking":
      return activeProgress("thinking", "Model is thinking…", "The response will appear as it arrives.", startedAt);
    case "assistant.delta":
    case "assistant.message":
      return activeProgress("streaming", "Streaming response…", "Text is arriving live.", startedAt);
    case "tool.started":
      return activeProgress("tool", `Running ${friendlyActivityName(event.name)}…`, "The agent is working on your request.", startedAt);
    case "tool.finished":
      return activeProgress(
        "tool",
        event.error
          ? `${friendlyActivityName(event.name)} failed; reviewing the result…`
          : `${friendlyActivityName(event.name)} finished; continuing…`,
        event.error ? summarize(event.error) : "The model is deciding the next step.",
        startedAt,
      );
    case "approval.required":
      return activeProgress("approval", "Waiting for your approval", "Review the requested action below.", startedAt);
    case "approval.resolved":
      return activeProgress(
        "thinking",
        event.decision === "approve" ? "Approved. Continuing…" : "Denied. Continuing safely…",
        "The agent is processing your decision.",
        startedAt,
      );
    case "browser.request":
      return activeProgress("tool", "Working in the browser…", friendlyActivityName(event.request.action), startedAt);
    case "run.completed": {
      const durationMs = event.durationMs ?? Math.max(0, now - startedAt);
      return {
        phase: "completed",
        label: "Response complete",
        detail: `Finished in ${formatRunDuration(durationMs)}.`,
        startedAt,
        durationMs,
      };
    }
    case "run.cancelled": {
      const durationMs = Math.max(0, now - startedAt);
      return {
        phase: "cancelled",
        label: "Run stopped",
        detail: `Stopped after ${formatRunDuration(durationMs)}.`,
        startedAt,
        durationMs,
      };
    }
    case "run.error": {
      const durationMs = Math.max(0, now - startedAt);
      return {
        phase: "error",
        label: "Run failed",
        detail: summarize(event.error),
        startedAt,
        durationMs,
      };
    }
  }
}

export function markRunStopping(current: RunProgress): RunProgress {
  if (!isActiveRunPhase(current.phase)) return current;
  return {
    ...current,
    phase: "stopping",
    label: "Stopping the run…",
    detail: "Finishing the current operation safely.",
  };
}

export function isEventForActiveRun(activeRunId: string, event: AgentEvent): boolean {
  return Boolean(activeRunId) && activeRunId === event.runId;
}

export function isActiveRunPhase(phase: RunPhase): boolean {
  return !["idle", "completed", "cancelled", "error"].includes(phase);
}

export function formatRunDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function activeProgress(phase: RunPhase, label: string, detail: string, startedAt: number): RunProgress {
  return { phase, label, detail, startedAt, durationMs: null };
}

function friendlyActivityName(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function timestampMs(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarize(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "run.completed" || event.type === "run.cancelled" || event.type === "run.error";
}
