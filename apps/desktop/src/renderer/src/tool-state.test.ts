import { describe, expect, it } from "vitest";
import { applyToolEvent, settlePendingTools } from "./tool-state";

const baseEvent = { runId: "run", timestamp: "2026-09-01T00:00:00.000Z" } as const;

describe("applyToolEvent", () => {
  it("replaces the previous tool row when another tool starts", () => {
    const previous = [{ id: "first", name: "fs_read", status: "done" as const }];
    const next = applyToolEvent(previous, {
      ...baseEvent,
      type: "tool.started",
      toolCallId: "second",
      name: "fs_write",
      arguments: {},
    });
    expect(next).toEqual([{ id: "second", name: "fs_write", status: "running" }]);
  });

  it("replaces an approval with the final tool result", () => {
    const approval = applyToolEvent([], {
      ...baseEvent,
      type: "approval.required",
      approvalId: "approval",
      kind: "write",
      summary: "Write app.ts",
      details: {},
    });
    expect(approval).toHaveLength(1);
    expect(approval[0]).toMatchObject({ id: "approval", status: "approval" });

    const finished = applyToolEvent(approval, {
      ...baseEvent,
      type: "tool.finished",
      toolCallId: "write-call",
      name: "fs_write",
      result: { ok: true },
    });
    expect(finished).toEqual([{ id: "write-call", name: "fs_write", status: "done" }]);
  });
});

describe("settlePendingTools", () => {
  it("settles running and approval rows without leaving actionable approval ids", () => {
    const settled = settlePendingTools([
      { id: "running", name: "shell", status: "running" },
      { id: "approval", name: "write_file", status: "approval", approvalId: "approve-me" },
      { id: "done", name: "read_file", status: "done", summary: "Read" },
    ], "Stopped before completion.");

    expect(settled).toEqual([
      { id: "running", name: "shell", status: "failed", summary: "Stopped before completion." },
      { id: "approval", name: "write_file", status: "failed", summary: "Stopped before completion." },
      { id: "done", name: "read_file", status: "done", summary: "Read" },
    ]);
  });
});
