import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { AgentEvent, AgentRunRequest } from "@browser-agent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "./agent-runner.js";
import { ApprovalManager } from "./approval-manager.js";
import { BrowserBridge } from "./browser-bridge.js";
import type { OpenRouterClient, OpenRouterToolCall } from "./openrouter.js";
import { ProjectService } from "./project-service.js";
import { ProjectStore } from "./project-store.js";
import { RepositoryMemoryFeature, RepositoryMemorySession } from "./repository-memory/index.js";
import { RepositoryMemoryStore } from "./repository-memory/store.js";

const temporaryDirectories: string[] = [];
const objective = "Review note.txt";
type CompletionInput = Parameters<OpenRouterClient["completeStream"]>[0];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    expect(target.startsWith(resolve(tmpdir()) + sep)).toBe(true);
    expect(basename(target).startsWith("span-agent-memory-test-")).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});

function tool(id: string, name: string, args: Record<string, unknown>): OpenRouterToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function handoff(expectedRevision = 0, overrides: Record<string, unknown> = {}) {
  return {
    action: "save_handoff", expectedRevision, objective,
    constraints: ["Preserve the public interface."], completed: ["Reviewed the fixture."],
    decisions: [], blockers: [], nextSteps: ["Confirm the next requested change."], validation: [], evidence: [],
    ...overrides,
  };
}

function complete(content: string | null, calls: OpenRouterToolCall[] = [], usage?: Record<string, number>) {
  return {
    message: { role: "assistant" as const, content, tool_calls: calls },
    finishReason: calls.length ? "tool_calls" : "stop",
    ...(usage ? { usage } : {}),
  };
}

async function fixture(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "span-agent-memory-test-"));
  temporaryDirectories.push(directory);
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(join(project, "note.txt"), "original fixture\n");
  const root = await realpath(project);
  const memoryDirectory = join(directory, "memory");
  const feature = new RepositoryMemoryFeature({ directory: memoryDirectory, enabled });
  const store = new RepositoryMemoryStore(memoryDirectory);
  const projects = new ProjectService(new ProjectStore(join(directory, "projects.json")));
  await projects.select({ path: root });
  const request: AgentRunRequest = {
    runId: "memory-run", sessionId: "memory-session", model: "test/model",
    messages: [{ role: "user", content: objective }],
    context: { projectRoot: root, elements: [], visualChanges: [], attachments: [] },
    approvalMode: "auto-safe",
  };
  const runner = (completeStream: ReturnType<typeof vi.fn>) => new AgentRunner(
    { completeStream } as unknown as OpenRouterClient,
    projects, new ApprovalManager(), new BrowserBridge(), undefined, feature,
  );
  const seed = async (messages?: AgentRunRequest["messages"]) => {
    const session = await feature.start({ root, sessionId: request.sessionId, runId: "seed-run", objective,
      ...(messages ? { historyCheckpoint: {
        messageCount: messages.length,
        digest: createHash("sha256").update(JSON.stringify(messages.map(({ role, content }) => ({ role, content })))).digest("hex"),
      } } : {}),
    });
    await session!.execute(handoff(0, { completed: ["Remembered investigation from the previous run."] }));
    await session!.finish();
  };
  return { root, feature, store, projects, request, runner, seed };
}

describe("native repository memory agent lifecycle", () => {
  it("withholds a premature answer until a real handoff is saved and counts every model step", async () => {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const completeStream = vi.fn()
      .mockImplementationOnce(async (input: CompletionInput) => {
        expect(input.tools.map((entry) => entry.function.name)).toContain("repository_memory");
        expect(JSON.stringify(input.messages)).toContain("Saved repository context");
        input.onChunk({ content: "Premature answer" });
        return complete("Premature answer", [], { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.1 });
      })
      .mockImplementationOnce(async () => {
        expect(events.some((event) => event.type === "assistant.delta" || event.type === "run.completed")).toBe(false);
        return complete(null, [tool("checkpoint", "repository_memory", handoff())],
          { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, cost: 0.2 });
      })
      .mockResolvedValueOnce(complete("Saved final answer", [], { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34, cost: 0.3 }));
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(completeStream).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.type === "assistant.message")).toEqual([
      expect.objectContaining({ content: "Saved final answer" }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", usage: { prompt_tokens: 60, completion_tokens: 9, total_tokens: 69 } });
    const state = await f.store.load(f.root);
    expect(state.handoffs[0]).toMatchObject({ sessionId: f.request.sessionId, revision: 1, objective });
    expect(state.runs[0]).toMatchObject({ status: "finished", handoffSaves: 1,
      providerInputTokens: 60, providerOutputTokens: 9, providerTotalTokens: 69 });
  });

  it("fails after bounded reminders when the model refuses to save its handoff", async () => {
    const f = await fixture();
    const completeStream = vi.fn().mockImplementation(async (input: CompletionInput) => {
      input.onChunk({ content: "I am done without a checkpoint." });
      return complete("I am done without a checkpoint.");
    });
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(completeStream).toHaveBeenCalledTimes(3);
    expect(events.some((event) => ["assistant.delta", "assistant.message", "run.completed"].includes(event.type))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run.error", code: "MEMORY_HANDOFF_REQUIRED" });
    const state = await f.store.load(f.root);
    expect(state.handoffs).toEqual([]);
    expect(state.runs[0]?.status).toBe("interrupted");
  });

  it("resumes saved context and preserves every user message while reducing older assistant history", async () => {
    const f = await fixture();
    const messages: AgentRunRequest["messages"] = [
      { role: "user", content: "Preserve the public interface." },
      { role: "assistant", content: "Older detailed investigation that the handoff now records." },
      { role: "user", content: "Also preserve the existing error behavior." },
      { role: "assistant", content: "The latest answer remains available for references." },
      { role: "user", content: objective },
    ];
    await f.seed(messages.slice(0, 4));
    const completeStream = vi.fn()
      .mockImplementationOnce(async (input: CompletionInput) => {
        const sent = input.messages.map((message) => message.content);
        for (const message of messages.filter((entry) => entry.role === "user")) expect(sent).toContain(message.content);
        expect(sent).toContain(messages[3]!.content);
        expect(sent).not.toContain(messages[1]!.content);
        expect(JSON.stringify(sent)).toContain("Remembered investigation from the previous run.");
        return complete(null, [tool("checkpoint", "repository_memory", handoff(1))]);
      })
      .mockResolvedValueOnce(complete("Resumed and saved."));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run({ ...f.request, messages }, (event) => events.push(event));
    expect(events.at(-1)?.type).toBe("run.completed");
    expect((await f.store.load(f.root)).handoffs[0]?.revision).toBe(2);
  });

  it.each(["missing checkpoint", "changed prefix"] as const)("keeps all assistant history with %s", async (condition) => {
    const f = await fixture();
    const covered: AgentRunRequest["messages"] = [
      { role: "user", content: "First user request" },
      { role: "assistant", content: "First assistant finding" },
      { role: "user", content: "Second user requirement" },
      { role: "assistant", content: "Second assistant finding" },
    ];
    await f.seed(condition === "missing checkpoint" ? undefined : covered);
    const messages = [...covered, { role: "user" as const, content: objective }];
    if (condition === "changed prefix") messages[0] = { role: "user", content: "User edited the first request" };
    const completeStream = vi.fn()
      .mockImplementationOnce(async (input: CompletionInput) => {
        const sent = input.messages.map((message) => message.content);
        for (const message of messages) expect(sent).toContain(message.content);
        return complete(null, [tool("checkpoint", "repository_memory", handoff(1))]);
      })
      .mockResolvedValueOnce(complete("Unverified history was retained."));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run({ ...f.request, messages }, (event) => events.push(event));
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("retains assistant work performed while memory was disabled beyond the saved history boundary", async () => {
    const f = await fixture();
    const covered: AgentRunRequest["messages"] = [
      { role: "user", content: "Original task requirement" },
      { role: "assistant", content: "Older finding covered by the handoff" },
      { role: "user", content: "An additional requirement" },
      { role: "assistant", content: "Latest covered finding" },
    ];
    await f.seed(covered);
    f.feature.setEnabled(false);
    const disabledMessages: AgentRunRequest["messages"] = [...covered, { role: "user", content: "Investigate while memory is off" }];
    const disabledModel = vi.fn().mockResolvedValue(complete("New investigation that was never saved to memory"));
    const disabledEvents: AgentEvent[] = [];
    await f.runner(disabledModel).run({ ...f.request, runId: "disabled-run", messages: disabledMessages }, (event) => disabledEvents.push(event));
    expect(disabledEvents.at(-1)?.type).toBe("run.completed");
    f.feature.setEnabled(true);
    const messages: AgentRunRequest["messages"] = [
      ...disabledMessages,
      { role: "assistant", content: "New investigation that was never saved to memory" },
      { role: "user", content: "Another follow-up during the disabled period" },
      { role: "assistant", content: "Latest answer outside the checkpoint" },
      { role: "user", content: objective },
    ];
    const completeStream = vi.fn()
      .mockImplementationOnce(async (input: CompletionInput) => {
        const sent = input.messages.map((message) => message.content);
        expect(sent).not.toContain(covered[1]!.content);
        for (const message of messages.filter((entry, index) => entry.role === "user" || index >= covered.length)) {
          expect(sent).toContain(message.content);
        }
        return complete(null, [tool("checkpoint", "repository_memory", handoff(1))]);
      })
      .mockResolvedValueOnce(complete("All unsaved work was preserved."));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run({ ...f.request, messages }, (event) => events.push(event));
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("keeps a long user request intact while using a bounded memory objective", async () => {
    const f = await fixture();
    const fullRequest = "Review note.txt. " + "Preserve this detailed user requirement. ".repeat(100);
    const completeStream = vi.fn()
      .mockImplementationOnce(async (input: CompletionInput) => {
        expect(input.messages.some((message) => message.role === "user" && message.content === fullRequest)).toBe(true);
        const saved = input.messages.find((message) => String(message.content).startsWith("Saved repository context"));
        const context = JSON.parse(String(saved?.content).split("\n").at(-1)!) as { currentObjective: string };
        expect(context.currentObjective.length).toBeLessThanOrEqual(2000);
        return complete(null, [tool("checkpoint", "repository_memory", handoff(0, { objective: context.currentObjective }))]);
      })
      .mockResolvedValueOnce(complete("The full request was preserved."));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run({ ...f.request, messages: [{ role: "user", content: fullRequest }] }, (event) => events.push(event));
    expect(completeStream).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("retains the last checkpoint on cancellation and warns the next run about unfinished work", async () => {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const completeStream = vi.fn()
      .mockResolvedValueOnce(complete(null, [tool("checkpoint", "repository_memory", handoff())]))
      .mockImplementationOnce(async (input: CompletionInput) => {
        runner.cancel(f.request.runId);
        input.onChunk({ content: "Late answer after cancellation" });
        return complete("Late answer after cancellation");
      });
    const runner = f.runner(completeStream);
    await runner.run(f.request, (event) => events.push(event));
    expect(events.at(-1)?.type).toBe("run.cancelled");
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
    const interrupted = await f.store.load(f.root);
    expect(interrupted.handoffs[0]?.revision).toBe(1);
    expect(interrupted.runs[0]).toMatchObject({ status: "interrupted", reason: "Run cancelled" });
    const resume = vi.fn()
      .mockImplementationOnce(async (input: CompletionInput) => {
        expect(JSON.stringify(input.messages)).toContain("unfinishedRun");
        expect(JSON.stringify(input.messages)).toContain("Run cancelled");
        return complete(null, [tool("resume-checkpoint", "repository_memory", handoff(1))]);
      })
      .mockResolvedValueOnce(complete("Resumed after cancellation."));
    const resumedEvents: AgentEvent[] = [];
    await f.runner(resume).run({ ...f.request, runId: "resumed-run" }, (event) => resumedEvents.push(event));
    expect(resumedEvents.at(-1)?.type).toBe("run.completed");
    expect((await f.store.load(f.root)).runs.at(-1)?.status).toBe("finished");
  });

  it("does not report completion when Stop arrives while the finish checkpoint is resolving", async () => {
    const f = await fixture();
    const completeStream = vi.fn()
      .mockResolvedValueOnce(complete(null, [tool("checkpoint", "repository_memory", handoff())]))
      .mockResolvedValueOnce(complete("This answer must not complete after Stop."));
    const runner = f.runner(completeStream);
    const originalFinish = RepositoryMemorySession.prototype.finish;
    vi.spyOn(RepositoryMemorySession.prototype, "finish").mockImplementation(async function(this: RepositoryMemorySession) {
      await originalFinish.call(this);
      runner.cancel(f.request.runId);
    });
    const events: AgentEvent[] = [];
    await runner.run(f.request, (event) => events.push(event));
    expect(events.at(-1)?.type).toBe("run.cancelled");
    expect(events.some((event) => event.type === "run.completed" || event.type === "assistant.message")).toBe(false);
    expect((await f.store.load(f.root)).handoffs[0]?.revision).toBe(1);
  });

  it("bypasses memory tools and preserves normal history while disabled", async () => {
    const f = await fixture();
    await f.seed();
    const before = await f.store.load(f.root);
    f.feature.setEnabled(false);
    const messages: AgentRunRequest["messages"] = [
      { role: "user", content: "Original user request" },
      { role: "assistant", content: "Original assistant history" },
      { role: "user", content: objective },
    ];
    const completeStream = vi.fn().mockImplementation(async (input: CompletionInput) => {
      expect(input.tools.map((entry) => entry.function.name)).not.toContain("repository_memory");
      expect(JSON.stringify(input.messages)).not.toContain("Saved repository context");
      for (const message of messages) expect(input.messages.map((entry) => entry.content)).toContain(message.content);
      return complete("Ordinary completion with memory disabled.");
    });
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run({ ...f.request, messages }, (event) => events.push(event));
    expect(completeStream).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(await f.store.load(f.root)).toEqual(before);
  });

  it("requires a fresh run when memory is turned off and back on during a model response", async () => {
    const f = await fixture();
    const completeStream = vi.fn().mockImplementation(async () => {
      f.feature.setEnabled(false);
      f.feature.setEnabled(true);
      return complete("Do not accept this answer from an invalidated memory session.");
    });
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(completeStream).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "run.error", code: "MEMORY_SESSION_INACTIVE" });
    expect(events.some((event) => event.type === "run.completed" || event.type === "assistant.message")).toBe(false);
    expect((await f.store.load(f.root)).handoffs).toEqual([]);
  });

  it("allows an ordinary finish after memory is turned off and keeps its prior checkpoint", async () => {
    const f = await fixture();
    await f.seed();
    const before = await f.store.load(f.root);
    const completeStream = vi.fn().mockImplementation(async () => {
      f.feature.setEnabled(false);
      return complete("Memory was disabled; the ordinary task can finish.");
    });
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(completeStream).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("run.completed");
    const after = await f.store.load(f.root);
    expect(after.handoffs).toEqual(before.handoffs);
    expect(after.runs.at(-1)).toMatchObject({ runId: f.request.runId, status: "running", handoffSaves: 0 });
  });

  it("enforces milestone checkpoints inside a tool batch and resumes tools after the saved checkpoint", async () => {
    const f = await fixture();
    const reads = Array.from({ length: 7 }, (_, index) => tool(`read-${index}`, "fs_read", { path: "note.txt" }));
    const completeStream = vi.fn()
      .mockResolvedValueOnce(complete(null, reads))
      .mockResolvedValueOnce(complete(null, [
        tool("checkpoint-one", "repository_memory", handoff()),
        tool("read-after-checkpoint", "fs_read", { path: "note.txt" }),
        tool("checkpoint-two", "repository_memory", handoff(1)),
      ]))
      .mockResolvedValueOnce(complete("Milestones were preserved."));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "read-6"))
      .toMatchObject({ error: expect.stringContaining("handoff before continuing") });
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "read-after-checkpoint"))
      .toMatchObject({ result: { content: "original fixture\n" } });
    expect(events.at(-1)?.type).toBe("run.completed");
    expect((await f.store.load(f.root)).handoffs[0]?.revision).toBe(2);
  });

  it("rejects edits based on a prior read after another writer changes the source", async () => {
    const f = await fixture();
    const completeStream = vi.fn()
      .mockResolvedValueOnce(complete(null, [tool("read", "fs_read", { path: "note.txt" })]))
      .mockImplementationOnce(async () => {
        await writeFile(join(f.root, "note.txt"), "another writer's changes\n");
        return complete(null, [tool("write", "fs_write", { path: "note.txt", content: "overwrite", overwrite: true })]);
      })
      .mockResolvedValueOnce(complete(null, [tool("checkpoint", "repository_memory", handoff(0, {
        completed: ["Read the fixture; a concurrent edit prevented writing."], validation: [],
      }))]))
      .mockResolvedValueOnce(complete("The concurrent changes were preserved."));
    const events: AgentEvent[] = [];
    await f.runner(completeStream).run(f.request, (event) => events.push(event));
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "write"))
      .toMatchObject({ error: expect.stringContaining("changed after it was read") });
    expect(await readFile(join(f.root, "note.txt"), "utf8")).toBe("another writer's changes\n");
    expect(events.at(-1)?.type).toBe("run.completed");
  });
});