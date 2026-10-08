import type { AgentEvent } from "@browser-agent/shared";
import { describe, expect, it } from "vitest";
import {
  beginRunProgress,
  formatRunDuration,
  IDLE_RUN_PROGRESS,
  isEventForActiveRun,
  isActiveRunPhase,
  markRunStopping,
  progressFromEvent,
} from "./run-progress";

const base = { runId: "run-1", timestamp: "2026-08-30T20:00:00.000Z" };

describe("desktop run progress", () => {
  it("moves through connection, thinking, streaming, and tool phases", () => {
    let progress = beginRunProgress("provider/model", 1_000);
    progress = progressFromEvent(progress, { ...base, type: "run.started", sessionId: "session-1", model: "provider/model" }, 1_100);
    expect(progress).toMatchObject({ phase: "starting", label: "Connected. Waiting for the model…" });

    progress = progressFromEvent(progress, { ...base, type: "assistant.thinking", delta: "private reasoning fragment" }, 1_200);
    expect(progress).toMatchObject({ phase: "thinking", detail: "The response will appear as it arrives." });
    expect(progress.detail).not.toContain("private reasoning");

    progress = progressFromEvent(progress, { ...base, type: "assistant.delta", delta: "Hello" }, 1_300);
    expect(progress).toMatchObject({ phase: "streaming", label: "Streaming response…" });

    progress = progressFromEvent(progress, {
      ...base,
      type: "tool.started",
      toolCallId: "tool-1",
      name: "fs_read",
      arguments: {},
    }, 1_400);
    expect(progress).toMatchObject({ phase: "tool", label: "Running Fs read…" });
  });

  it("shows approval and terminal outcomes with bounded duration", () => {
    const started = beginRunProgress("provider/model", 10_000);
    const approval = progressFromEvent(started, {
      ...base,
      type: "approval.required",
      approvalId: "approval-1",
      kind: "write",
      summary: "Write a file",
      details: {},
    }, 12_000);
    expect(approval).toMatchObject({ phase: "approval", label: "Waiting for your approval" });

    const completed = progressFromEvent(approval, {
      ...base,
      type: "run.completed",
      content: "Done",
      durationMs: 65_000,
    }, 75_000);
    expect(completed).toMatchObject({ phase: "completed", detail: "Finished in 1:05.", durationMs: 65_000 });
    expect(isActiveRunPhase(completed.phase)).toBe(false);
  });

  it("formats elapsed time and leaves idle inactive", () => {
    expect(formatRunDuration(999)).toBe("0s");
    expect(formatRunDuration(61_900)).toBe("1:01");
    expect(isActiveRunPhase(IDLE_RUN_PROGRESS.phase)).toBe(false);
  });

  it("summarizes run failures instead of overflowing the progress row", () => {
    const error = progressFromEvent(beginRunProgress("provider/model", 0), {
      ...base,
      type: "run.error",
      error: `Provider failed ${"x".repeat(300)}`,
    } satisfies AgentEvent, 2_000);

    expect(error.phase).toBe("error");
    expect(error.detail.length).toBeLessThanOrEqual(180);
  });

  it("marks cancellation immediately and ignores non-terminal progress while stopping", () => {
    const stopping = markRunStopping(beginRunProgress("provider/model", 1_000));
    expect(stopping).toMatchObject({ phase: "stopping", label: "Stopping the run…" });

    const lateToken = progressFromEvent(stopping, {
      ...base,
      type: "assistant.delta",
      delta: "late fragment",
    }, 1_500);
    expect(lateToken).toEqual(stopping);

    const cancelled = progressFromEvent(stopping, { ...base, type: "run.cancelled" }, 2_000);
    expect(cancelled.phase).toBe("cancelled");
  });

  it("accepts events only for the active run", () => {
    expect(isEventForActiveRun("run-1", { ...base, type: "run.cancelled" })).toBe(true);
    expect(isEventForActiveRun("run-2", { ...base, type: "run.cancelled" })).toBe(false);
    expect(isEventForActiveRun("", { ...base, type: "run.cancelled" })).toBe(false);
  });
});
