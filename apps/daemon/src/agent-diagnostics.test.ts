import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { AgentEvent, AgentRunRequest, RunDiagnostics } from "@browser-agent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, historyDigest } from "./agent-runner.js";
import { ApprovalManager } from "./approval-manager.js";
import { BrowserBridge } from "./browser-bridge.js";
import { CodebaseMapFeature } from "./codebase-map/index.js";
import type { OpenRouterClient, OpenRouterToolCall } from "./openrouter.js";
import { ProjectService } from "./project-service.js";
import { ProjectStore } from "./project-store.js";
import { RepositoryMemoryFeature } from "./repository-memory/index.js";

const temporaryDirectories: string[] = [];
const objective = "Review the private diagnostics fixture.";
const privateContent = "private fixture body that must not appear in a run report\n";
type CompletionInput = Parameters<OpenRouterClient["completeStream"]>[0];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    expect(target.startsWith(resolve(tmpdir()) + sep)).toBe(true);
    expect(basename(target).startsWith("span-agent-diagnostics-test-")).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});

function tool(id: string, name: string, args: Record<string, unknown>): OpenRouterToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function handoff(expectedRevision = 0) {
  return {
    action: "save_handoff", expectedRevision, objective,
    constraints: [], completed: ["Reviewed the fixture."], decisions: [], blockers: [],
    nextSteps: [], validation: [], evidence: [],
  };
}

function complete(content: string | null, calls: OpenRouterToolCall[] = [], usage?: Record<string, number>) {
  return {
    message: { role: "assistant" as const, content, tool_calls: calls },
    finishReason: calls.length ? "tool_calls" : "stop",
    ...(usage ? { usage } : {}),
  };
}

async function fixture(memoryEnabled = false, mapEnabled = false) {
  const directory = await mkdtemp(join(tmpdir(), "span-agent-diagnostics-test-"));
  temporaryDirectories.push(directory);
  const project = join(directory, "private-project");
  await mkdir(project);
  await writeFile(join(project, "private-note.txt"), privateContent);
  await writeFile(join(project, "index.ts"), "export function fixtureValue() { return 42; }\n");
  const root = await realpath(project);
  const memory = new RepositoryMemoryFeature({ directory: join(directory, "memory"), enabled: memoryEnabled });
  const map = new CodebaseMapFeature({ cacheDirectory: join(directory, "map"), enabled: mapEnabled });
  const projects = new ProjectService(new ProjectStore(join(directory, "projects.json")));
  await projects.select({ path: root });
  const request: AgentRunRequest = {
    runId: "diagnostics-run", sessionId: "diagnostics-session", model: "test/model",
    messages: [{ role: "user", content: objective }],
    context: { projectRoot: root, elements: [], visualChanges: [], attachments: [] },
    approvalMode: "auto-safe",
  };
  const runner = (completeStream: ReturnType<typeof vi.fn>) => new AgentRunner(
    { completeStream } as unknown as OpenRouterClient,
    projects, new ApprovalManager(), new BrowserBridge(), map, memory,
  );
  return { root, memory, map, request, runner };
}

function diagnostics(events: AgentEvent[], terminalType: "run.completed" | "run.error" | "run.cancelled" = "run.completed"): RunDiagnostics {
  const terminal = events.at(-1);
  expect(terminal?.type).toBe(terminalType);
  if (!terminal || !(terminal.type === "run.completed" || terminal.type === "run.error" || terminal.type === "run.cancelled")) {
    throw new Error("Expected a terminal run event");
  }
  expect(terminal.diagnostics).toBeDefined();
  return terminal.diagnostics!;
}

describe("native agent run diagnostics", () => {
  it("reports a memory-off baseline and preserves actual zero usage without storing conversation data", async () => {
    const f = await fixture();
    const completeStream = vi.fn().mockResolvedValue(complete("Private final response", [], {
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0,
    }));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    const report = diagnostics(events);
    expect(report).toMatchObject({
      version: 1, policy: "repository-memory-v1", requestedModel: "test/model",
      memoryEnabled: false, mapEnabled: false, settingsChanged: false, checkpointInterval: 6,
      modelRequests: 1, modelResponses: 1,
      usage: { coverage: "complete", responsesWithUsage: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
      context: { restoredBytes: 0, omittedHistoryMessages: 0, omittedHistoryBytes: 0, resumedHandoff: false },
      tools: { attempted: 0, succeeded: 0, failed: 0, mapAttempts: 0, mapSucceeded: 0,
        sourceReads: 0, repeatedSourceReads: 0, staleEditRejections: 0, unreadEditRejections: 0 },
      memory: { handoffSaves: 0, noteSaves: 0, checkpointReminders: 0, checkpointBlockedTools: 0 },
    });
    expect(Number.isInteger(report.durationMs)).toBe(true);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    const serialized = JSON.stringify(report);
    for (const privateValue of [objective, privateContent, f.root, "private-note.txt", "Private final response", f.request.sessionId]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("distinguishes unavailable usage from valid zero counts and marks incomplete responses partial", async () => {
    const f = await fixture();
    const missingEvents: AgentEvent[] = [];
    await f.runner(vi.fn().mockResolvedValue(complete("No provider usage")))
      .run(f.request, (event) => missingEvents.push(event));
    expect(diagnostics(missingEvents).usage).toEqual({ coverage: "unavailable", responsesWithUsage: 0 });

    const partialEvents: AgentEvent[] = [];
    const completeStream = vi.fn()
      .mockResolvedValueOnce(complete(null, [tool("read", "fs_read", { path: "private-note.txt" })], {
        prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, cost: 0.125,
      }))
      .mockResolvedValueOnce(complete("Provider omitted completion usage", [], { prompt_tokens: 5 }));
    await f.runner(completeStream).run({ ...f.request, runId: "partial-usage-run" }, (event) => partialEvents.push(event));
    expect(diagnostics(partialEvents)).toMatchObject({ modelRequests: 2, modelResponses: 2,
      usage: { coverage: "partial", responsesWithUsage: 1, promptTokens: 16, completionTokens: 3, totalTokens: 14 } });
    expect(diagnostics(partialEvents).usage).not.toHaveProperty("costUsd");
  });

  it("counts failed and malformed tool attempts while canonicalizing repeated source reads with memory off", async () => {
    const f = await fixture();
    const malformed = tool("malformed", "fs_read", {});
    malformed.function.arguments = "[invalid-json";
    const completeStream = vi.fn()
      .mockResolvedValueOnce(complete(null, [
        tool("read", "fs_read", { path: "private-note.txt" }),
        tool("same-file", "fs_read", { path: "./private-note.txt" }),
        malformed,
        tool("missing", "fs_read", { path: "absent.txt" }),
        tool("map-disabled", "codebase_map", { action: "project_overview" }),
      ]))
      .mockResolvedValueOnce(complete("Finished reading"));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    const report = diagnostics(events);
    expect(report.tools).toMatchObject({ attempted: 5, succeeded: 2, failed: 3,
      sourceReads: 2, repeatedSourceReads: 1, mapAttempts: 1, mapSucceeded: 0 });
    expect(JSON.stringify(report)).not.toContain("private-note.txt");
    expect(JSON.stringify(report)).not.toContain(privateContent.trim());
  });

  it("counts actual map use separately from a rejected map query", async () => {
    const f = await fixture(false, true);
    const completeStream = vi.fn()
      .mockResolvedValueOnce(complete(null, [
        tool("overview", "codebase_map", { action: "project_overview" }),
        tool("bad-query", "codebase_map", { action: "not_an_action" }),
      ]))
      .mockResolvedValueOnce(complete("Inspected the map"));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(diagnostics(events)).toMatchObject({ mapEnabled: true, memoryEnabled: false,
      tools: { attempted: 2, succeeded: 1, failed: 1, mapAttempts: 2, mapSucceeded: 1, sourceReads: 0 } });
  });

  it.each([false, true])("retains usage when a later provider call fails (memory enabled: %s)", async (memoryEnabled) => {
    const f = await fixture(memoryEnabled);
    const completeStream = vi.fn()
      .mockResolvedValueOnce(complete(null, [tool("read", "fs_read", { path: "private-note.txt" })], {
        prompt_tokens: 25, completion_tokens: 7, total_tokens: 32, cost: 0.015,
      }))
      .mockRejectedValueOnce(new Error("Provider disconnected"));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(diagnostics(events, "run.error")).toMatchObject({ memoryEnabled, settingsChanged: false, modelRequests: 2, modelResponses: 1,
      usage: { coverage: "partial", responsesWithUsage: 1, promptTokens: 25, completionTokens: 7, totalTokens: 32 },
      tools: { attempted: 1, succeeded: 1, failed: 0 } });
    expect(diagnostics(events, "run.error").usage).not.toHaveProperty("costUsd");
  });

  it.each([false, true])("retains streamed usage without a completed provider response (Stop: %s)", async (stopped) => {
    const f = await fixture(true);
    const completeStream = vi.fn().mockImplementation(async (input: CompletionInput) => {
      input.onChunk({ usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10, cost: 0.01 } });
      input.onChunk({ usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, cost: 0.04 } });
      if (stopped) {
        runner.cancel(f.request.runId);
        throw input.signal!.reason;
      }
      throw new Error("Connection failed after usage was received");
    });
    const runner = f.runner(completeStream);
    const events: AgentEvent[] = [];
    await runner.run(f.request, (event) => events.push(event));
    const report = diagnostics(events, stopped ? "run.cancelled" : "run.error");
    expect(report).toMatchObject({ settingsChanged: false, modelRequests: 1, modelResponses: 0,
      usage: { coverage: "partial", responsesWithUsage: 0, promptTokens: 9, completionTokens: 4, totalTokens: 13 } });
    expect(report.usage).not.toHaveProperty("costUsd");
  });

  it("counts cumulative usage chunks and a final usage response once per model request", async () => {
    const f = await fixture();
    const completeStream = vi.fn().mockImplementation(async (input: CompletionInput) => {
      input.onChunk({ usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9, cost: 0.01 } });
      input.onChunk({ usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13, cost: 0.05 } });
      return complete("Completed stream", [], { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13, cost: 0.05 });
    });
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(diagnostics(events)).toMatchObject({ modelRequests: 1, modelResponses: 1,
      usage: { coverage: "complete", responsesWithUsage: 1, promptTokens: 8, completionTokens: 5, totalTokens: 13, costUsd: 0.05 } });
  });
  it.each([false, true])("retains known usage when Stop arrives during a provider call (response returned: %s)", async (responseReturned) => {
    const f = await fixture(true);
    const completeStream = vi.fn()
      .mockResolvedValueOnce(complete(null, [tool("read", "fs_read", { path: "private-note.txt" })], {
        prompt_tokens: 12, completion_tokens: 3, total_tokens: 15,
      }))
      .mockImplementationOnce(async (input: CompletionInput) => {
        expect(runner.cancel(f.request.runId)).toBe(true);
        if (!responseReturned) throw input.signal!.reason;
        return complete("Late answer", [], { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 });
      });
    const runner = f.runner(completeStream);
    const events: AgentEvent[] = [];
    await runner.run(f.request, (event) => events.push(event));
    expect(diagnostics(events, "run.cancelled")).toMatchObject({ memoryEnabled: true, settingsChanged: false, modelRequests: 2, modelResponses: responseReturned ? 2 : 1,
      usage: { coverage: responseReturned ? "complete" : "partial", responsesWithUsage: responseReturned ? 2 : 1,
        promptTokens: responseReturned ? 20 : 12, completionTokens: responseReturned ? 5 : 3, totalTokens: responseReturned ? 25 : 15 } });
    expect(events.some((event) => event.type === "run.completed" || event.type === "assistant.message")).toBe(false);
  });

  it("reports actual checkpoint prompts and blocked tools rather than counting failed save attempts as progress", async () => {
    const f = await fixture(true);
    const reads = Array.from({ length: 7 }, (_, index) => tool(`read-${index}`, "fs_read", { path: "private-note.txt" }));
    const completeStream = vi.fn()
      .mockResolvedValueOnce(complete(null, reads))
      .mockResolvedValueOnce(complete(null, [
        tool("conflicting-checkpoint", "repository_memory", handoff(99)),
        tool("checkpoint", "repository_memory", handoff()),
        tool("read-after-checkpoint", "fs_read", { path: "private-note.txt" }),
        tool("unverified-note", "repository_memory", { action: "save_project_note", expectedRevision: 0, id: "unverified-claim", kind: "code-claim", text: "Unverified source claim", reason: "Must be rejected", scopePaths: [], evidence: [] }),
        tool("note", "repository_memory", { action: "save_project_note", expectedRevision: 0,
          id: "fixture-decision", kind: "decision", text: "Retain the fixture", reason: "Supports comparison", scopePaths: [], evidence: [] }),
        tool("final-checkpoint", "repository_memory", handoff(1)),
      ]))
      .mockResolvedValueOnce(complete("Milestones recorded"));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(diagnostics(events)).toMatchObject({ modelRequests: 3, modelResponses: 3,
      tools: { attempted: 13, succeeded: 10, failed: 3, sourceReads: 7, repeatedSourceReads: 6 },
      memory: { handoffSaves: 2, noteSaves: 1, checkpointReminders: 1, checkpointBlockedTools: 1 } });
  });

  it("includes the two actual finish reminders when handoff refusal exhausts the run", async () => {
    const f = await fixture(true);
    const completeStream = vi.fn().mockResolvedValue(complete("Finished without a handoff", [], {
      prompt_tokens: 10, completion_tokens: 2, total_tokens: 12,
    }));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(diagnostics(events, "run.error")).toMatchObject({ modelRequests: 3, modelResponses: 3,
      usage: { coverage: "complete", responsesWithUsage: 3, promptTokens: 30, completionTokens: 6, totalTokens: 36 },
      memory: { handoffSaves: 0, checkpointReminders: 2, checkpointBlockedTools: 0 } });
    expect(events.at(-1)).toMatchObject({ code: "MEMORY_HANDOFF_REQUIRED" });
  });

  it("measures restored context and only history actually omitted by a verified checkpoint", async () => {
    const f = await fixture(true);
    const covered: AgentRunRequest["messages"] = [
      { role: "user", content: "Keep the user requirement" },
      { role: "assistant", content: "Private old investigation with non-ASCII text: café" },
      { role: "user", content: "Keep the additional requirement" },
      { role: "assistant", content: "Keep the latest reply" },
    ];
    const seed = await f.memory.start({ root: f.root, runId: "seed-run", sessionId: f.request.sessionId, objective,
      historyCheckpoint: { messageCount: covered.length, digest: historyDigest(covered) } });
    await seed!.execute(handoff());
    await seed!.finish();
    let restoredBytes = 0;
    const completeStream = vi.fn()
      .mockImplementationOnce(async (input: CompletionInput) => {
        const saved = input.messages.find((message) => typeof message.content === "string" && message.content.startsWith("Saved repository context"));
        expect(saved).toBeDefined();
        const context = String(saved!.content);
        restoredBytes = Buffer.byteLength(context);
        expect(input.messages.some((message) => message.content === covered[1]!.content)).toBe(false);
        return complete(null, [tool("checkpoint", "repository_memory", handoff(1))]);
      })
      .mockResolvedValueOnce(complete("Resumed"));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run({ ...f.request, messages: [...covered, ...f.request.messages] }, (event) => events.push(event));
    const report = diagnostics(events);
    expect(report.context).toEqual({ restoredBytes, omittedHistoryMessages: 1,
      omittedHistoryBytes: Buffer.byteLength(covered[1]!.content), resumedHandoff: true });
    expect(restoredBytes).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain(covered[1]!.content);
  });

  it("distinguishes unread-source and stale-source edit rejections without recording source paths", async () => {
    const f = await fixture(true);
    const completeStream = vi.fn()
      .mockResolvedValueOnce(complete(null, [
        tool("unread-write", "fs_write", { path: "private-note.txt", content: "overwrite", overwrite: true }),
        tool("read", "fs_read", { path: "private-note.txt" }),
      ]))
      .mockImplementationOnce(async () => {
        await writeFile(join(f.root, "private-note.txt"), "A concurrent writer changed this file\n");
        return complete(null, [tool("stale-write", "fs_write", { path: "private-note.txt", content: "overwrite", overwrite: true })]);
      })
      .mockResolvedValueOnce(complete(null, [tool("checkpoint", "repository_memory", handoff())]))
      .mockResolvedValueOnce(complete("Concurrent work retained"));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    const report = diagnostics(events);
    expect(report.tools).toMatchObject({ attempted: 4, succeeded: 2, failed: 2,
      unreadEditRejections: 1, staleEditRejections: 1, sourceReads: 1 });
    expect(await readFile(join(f.root, "private-note.txt"), "utf8")).toBe("A concurrent writer changed this file\n");
    expect(JSON.stringify(report)).not.toContain("private-note.txt");
  });

  it("marks an invalidated memory session as a changed-setting run and retains its provider usage", async () => {
    const f = await fixture(true);
    const completeStream = vi.fn().mockImplementation(async () => {
      f.memory.setEnabled(false);
      f.memory.setEnabled(true);
      return complete("Invalidated answer", [], { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 });
    });
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(diagnostics(events, "run.error")).toMatchObject({ memoryEnabled: true, settingsChanged: true,
      modelRequests: 1, modelResponses: 1,
      usage: { coverage: "complete", responsesWithUsage: 1, promptTokens: 6, completionTokens: 2, totalTokens: 8 } });
    expect(events.at(-1)).toMatchObject({ code: "MEMORY_SESSION_INACTIVE" });
  });

  it("keeps initial comparison flags when map settings change during a baseline run", async () => {
    const f = await fixture(false, true);
    const completeStream = vi.fn().mockImplementation(async () => {
      f.map.setEnabled(false);
      return complete("Mapping disabled during this run");
    });
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(diagnostics(events)).toMatchObject({ mapEnabled: true, memoryEnabled: false, settingsChanged: true });
  });

  it.each(["memory", "map"] as const)("records a quick %s setting cycle even when the initial setting is restored", async (feature) => {
    const f = await fixture();
    const completeStream = vi.fn().mockImplementation(async () => {
      f[feature].setEnabled(true);
      f[feature].setEnabled(false);
      return complete("Setting restored before the response");
    });
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(diagnostics(events)).toMatchObject({ mapEnabled: false, memoryEnabled: false, settingsChanged: true });
  });

  it("does not mark unchanged settings as a changed-setting run", async () => {
    const f = await fixture();
    const completeStream = vi.fn().mockImplementation(async () => {
      f.memory.setEnabled(false);
      f.map.setEnabled(false);
      return complete("Settings remained the same");
    });
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(diagnostics(events).settingsChanged).toBe(false);
  });

  it("counts a completed tool once when event delivery subsequently fails", async () => {
    const f = await fixture();
    const completeStream = vi.fn().mockResolvedValue(complete(null, [
      tool("read", "fs_read", { path: "private-note.txt" }),
    ]));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => {
      if (event.type === "tool.finished") throw new Error("Event delivery failed");
      events.push(event);
    });
    expect(diagnostics(events, "run.error").tools).toMatchObject({ attempted: 1, succeeded: 1, failed: 0, sourceReads: 1 });
    expect(completeStream).toHaveBeenCalledTimes(1);
  });
});
