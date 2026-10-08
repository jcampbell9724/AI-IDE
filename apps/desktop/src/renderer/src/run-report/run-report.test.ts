import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentEvent, RunDiagnostics } from "@browser-agent/shared";
import type { StorageLike } from "../persist";
import { RunReportPanel } from "./RunReportPanel";
import { exportRunReports, loadRunReports, prependRunReport, reportFromEvent, RUN_REPORT_KEY_PREFIX, saveRunReports, type RunReport } from "./store";

function diagnostics(): RunDiagnostics {
  return {
    version: 1, policy: "repository-memory-v1", requestedModel: "test/model", memoryEnabled: false, mapEnabled: true,
    settingsChanged: false, checkpointInterval: 6, durationMs: 12_500, modelRequests: 2, modelResponses: 2,
    usage: { coverage: "complete", responsesWithUsage: 2, promptTokens: 1000, completionTokens: 200, totalTokens: 1200, costUsd: 0.001 },
    context: { restoredBytes: 0, omittedHistoryMessages: 0, omittedHistoryBytes: 0, resumedHandoff: false },
    tools: { attempted: 5, succeeded: 4, failed: 1, mapAttempts: 2, mapSucceeded: 2, sourceReads: 2, repeatedSourceReads: 1, staleEditRejections: 0, unreadEditRejections: 1 },
    memory: { handoffSaves: 0, noteSaves: 0, checkpointReminders: 0, checkpointBlockedTools: 0 },
  };
}

function report(runId = "run-1"): RunReport {
  return { runId, timestamp: "2026-09-13T12:00:00.000Z", outcome: "completed", diagnostics: diagnostics() };
}

function storage(): StorageLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
}

describe("project run reports", () => {
  it("restores only the selected project's reports and normalizes Windows path spelling", () => {
    const local = storage();
    saveRunReports("C:\\Projects\\First", [report("first")], local);
    saveRunReports("C:\\Projects\\Second", [report("second")], local);
    expect(loadRunReports("c:/projects/FIRST/", local).map((item) => item.runId)).toEqual(["first"]);
    expect(loadRunReports("C:\\Projects\\Second", local).map((item) => item.runId)).toEqual(["second"]);
    expect(loadRunReports("C:\\Projects\\Third", local)).toEqual([]);
    expect(loadRunReports(null, local)).toEqual([]);
  });

  it("preserves case for distinct case-sensitive project paths", () => {
    const local = storage();
    saveRunReports("/projects/First", [report("upper")], local);
    saveRunReports("/projects/first", [report("lower")], local);
    expect(loadRunReports("/projects/First", local)[0]?.runId).toBe("upper");
    expect(loadRunReports("/projects/first", local)[0]?.runId).toBe("lower");
  });

  it("keeps the latest 20 unique runs and replaces duplicate terminal reports", () => {
    let reports: RunReport[] = [];
    for (let i = 0; i < 25; i += 1) reports = prependRunReport(reports, report(`run-${i}`));
    expect(reports).toHaveLength(20);
    expect(reports.map((item) => item.runId)).toEqual(Array.from({ length: 20 }, (_, i) => `run-${24 - i}`));
    reports = prependRunReport(reports, { ...report("run-20"), outcome: "cancelled" });
    expect(reports).toHaveLength(20);
    expect(reports[0]?.outcome).toBe("cancelled");
    expect(reports.filter((item) => item.runId === "run-20")).toHaveLength(1);
  });

  it.each(["run.completed", "run.error", "run.cancelled"] as const)("captures %s with memory off without retaining terminal content", (type) => {
    const event = { type, runId: "run-1", timestamp: report().timestamp, content: "PRIVATE RESPONSE", error: "PRIVATE ERROR", diagnostics: diagnostics() } as AgentEvent;
    const result = reportFromEvent(event);
    expect(result?.outcome).toBe(type.slice(4));
    expect(result?.diagnostics.memoryEnabled).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("does not invent measurements for older events or streaming events", () => {
    expect(reportFromEvent({ type: "run.error", runId: "run-1", timestamp: report().timestamp, error: "network" })).toBeNull();
    expect(reportFromEvent({ type: "assistant.delta", runId: "run-1", timestamp: report().timestamp, delta: "text" })).toBeNull();
  });

  it("strips additional payload fields from storage and clipboard exports", () => {
    const local = storage();
    const privateReport = {
      ...report(), projectPath: "PRIVATE PATH", prompt: "PRIVATE PROMPT", error: "PRIVATE ERROR",
      diagnostics: diagnostics(),
    };
    expect(saveRunReports("C:\\PRIVATE PATH", [privateReport], local)).toBe(true);
    const serialized = [...local.values.values()][0]!;
    expect(serialized).not.toContain("PRIVATE");
    expect(exportRunReports([privateReport])).not.toContain("PRIVATE");
    expect(JSON.parse(exportRunReports([privateReport])).reports).toEqual([report()]);
  });

  it("rejects diagnostics containing unknown nested payloads", () => {
    const local = storage();
    const invalid = { ...report("invalid"), diagnostics: { ...diagnostics(), context: { ...diagnostics().context, source: "PRIVATE SOURCE" } } };
    saveRunReports("C:/project", [invalid, report("valid")], local);
    expect(loadRunReports("C:/project", local).map((item) => item.runId)).toEqual(["valid"]);
    expect(exportRunReports([invalid])).not.toContain("PRIVATE");
    expect(JSON.parse(exportRunReports([invalid])).reports).toEqual([]);
  });

  it("rejects malformed storage and invalid records while retaining valid reports", () => {
    const local = storage();
    const key = `${RUN_REPORT_KEY_PREFIX}:${encodeURIComponent("c:/project")}`;
    for (const value of ["broken JSON", JSON.stringify({ version: 2, reports: [report()] }), "x".repeat(400_001)]) {
      local.setItem(key, value);
      expect(loadRunReports("C:/project", local)).toEqual([]);
    }
    local.setItem(key, JSON.stringify({ version: 1, reports: [
      { ...report("negative"), diagnostics: { ...diagnostics(), durationMs: -1 } },
      { ...report("future-policy"), diagnostics: { ...diagnostics(), version: 9 } },
      { ...report("invalid-time"), timestamp: "yesterday" },
      report("valid"),
    ] }));
    expect(loadRunReports("C:/project", local).map((item) => item.runId)).toEqual(["valid"]);
  });

  it("clears the current project's reports without touching another project or chat data", () => {
    const local = storage();
    local.setItem("chat-history", "PRIVATE CHAT");
    saveRunReports("C:/first", [report("first")], local);
    saveRunReports("C:/second", [report("second")], local);
    expect(saveRunReports("C:/first", [], local)).toBe(true);
    expect(loadRunReports("C:/first", local)).toEqual([]);
    expect(loadRunReports("C:/second", local)).toHaveLength(1);
    expect(local.getItem("chat-history")).toBe("PRIVATE CHAT");
    expect(local.values.size).toBe(2);
  });

  it("does not interrupt a run when storage is unavailable or full", () => {
    const unavailable = { getItem() { throw new Error("unavailable"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("unavailable"); } };
    expect(loadRunReports("C:/project", unavailable)).toEqual([]);
    expect(saveRunReports("C:/project", [report()], unavailable)).toBe(false);
    expect(saveRunReports("C:/project", [], unavailable)).toBe(false);
    expect(saveRunReports("C:/project", [report()], null)).toBe(false);
    expect(loadRunReports("C:/project", null)).toEqual([]);
  });
});

function render(reports: RunReport[], storageWarning = false): string {
  return renderToStaticMarkup(createElement(RunReportPanel, { reports, storageWarning, onClear: () => {}, onDelete: () => {} }));
}

describe("native run report panel", () => {
  it("starts collapsed, labels recent-run selection, and provides local copy and deletion controls", () => {
    const markup = render([report("latest"), { ...report("previous"), outcome: "error" }]);
    expect(markup).toContain('<details class="run-report">');
    expect(markup).not.toMatch(/<details[^>]*\bopen/);
    expect(markup).toMatch(/<label for="[^"]+">Recent run<\/label><select id="[^"]+"/);
    expect(markup).toContain("2 recent runs");
    for (const label of ["Copy report", "Copy reports", "Delete report", "Clear reports"]) expect(markup).toContain(`>${label}</button>`);
    expect(markup).toContain("Completed");
    expect(markup).toContain("Failed");
    expect(markup).toContain("test/model");
  });

  it("shows missing usage as unavailable, never a fabricated zero", () => {
    const entry = report();
    entry.diagnostics.usage = { coverage: "unavailable", responsesWithUsage: 0 };
    const markup = render([entry]);
    expect(markup).toContain("<dt>Reported input tokens</dt><dd>Unavailable</dd>");
    expect(markup).toContain("<dt>Reported cost (USD)</dt><dd>Unavailable</dd>");
    expect(markup).toContain("Provider usage is unavailable");
    expect(markup).toContain("<dt>Repository memory</dt><dd>Off</dd>");
    expect(markup).toContain("not token savings");
  });

  it("labels partial measurements and settings changes, while preserving a measured zero", () => {
    const entry = report();
    entry.diagnostics.settingsChanged = true;
    entry.diagnostics.usage = { coverage: "partial", responsesWithUsage: 1, promptTokens: 100, completionTokens: 0, totalTokens: 100 };
    const markup = render([entry]);
    expect(markup).toContain("Partial");
    expect(markup).toContain("<dt>Reported output tokens</dt><dd>0</dd>");
    expect(markup).toContain("settings changed during this run");
    expect(markup).toContain("reported values may not cover the whole run");
  });

  it("keeps the conversation clean until a report exists and explains failed local persistence", () => {
    expect(render([])).toBe("");
    expect(render([], true)).toContain('role="status"');
    expect(render([report()], true)).toContain("Copy them before closing Span");
  });
});
