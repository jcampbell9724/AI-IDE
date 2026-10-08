import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunRequest } from "@browser-agent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "./agent-runner.js";
import { ApprovalManager } from "./approval-manager.js";
import { BrowserBridge } from "./browser-bridge.js";
import type { OpenRouterClient } from "./openrouter.js";
import { ProjectService } from "./project-service.js";
import { ProjectStore } from "./project-store.js";
import { WorkspaceGuard } from "./workspace-guard.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-project-lock-"));
  roots.push(root);
  const first = join(root, "first");
  const second = join(root, "second");
  await Promise.all([first, second].map(async (path) => {
    await mkdir(path);
    await writeFile(join(path, "note.txt"), path === first ? "first" : "second");
  }));
  const projects = new ProjectService(new ProjectStore(join(root, "state.json")));
  await projects.select({ path: first });
  const request: AgentRunRequest = {
    runId: "project-run", sessionId: "project-session", model: "test/model",
    messages: [{ role: "user", content: "Read and update note.txt" }],
    context: { projectRoot: first, elements: [], visualChanges: [], attachments: [] },
    approvalMode: "auto-safe",
  };
  return { first, second, projects, request };
}

describe("agent project binding", () => {
  it("rejects switching and clearing during a run and keeps reads and writes on its workspace", async () => {
    const { first, second, projects, request } = await fixture();
    const otherGuard = await WorkspaceGuard.create(second);
    const workspaceLookup = vi.spyOn(projects, "workspace").mockResolvedValue(otherGuard);
    const completeStream = vi.fn()
      .mockImplementationOnce(async () => {
        await expect(projects.select({ path: second })).rejects.toMatchObject({ code: "PROJECT_IN_USE" });
        await expect(projects.clearCurrent()).rejects.toMatchObject({ code: "PROJECT_IN_USE" });
        return {
          message: { role: "assistant", content: null, tool_calls: [
            { id: "read", type: "function", function: { name: "fs_read", arguments: JSON.stringify({ path: "note.txt" }) } },
            { id: "write", type: "function", function: { name: "fs_write", arguments: JSON.stringify({ path: "note.txt", content: "updated first", overwrite: true }) } },
          ] }, finishReason: "tool_calls",
        };
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "Done" }, finishReason: "stop" });
    const runner = new AgentRunner({ completeStream } as unknown as OpenRouterClient, projects, new ApprovalManager(), new BrowserBridge());
    const events: AgentEvent[] = [];
    await runner.run(request, (event) => events.push(event));
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "read"))
      .toMatchObject({ result: { content: "first" } });
    expect(await readFile(join(first, "note.txt"), "utf8")).toBe("updated first");
    expect(await readFile(join(second, "note.txt"), "utf8")).toBe("second");
    expect(workspaceLookup).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("run.completed");
    await projects.select({ path: second });
    expect((await projects.current()).root).toBe(second);
  });

  it.each(["error", "cancel"] as const)("releases project selection after %s", async (outcome) => {
    const { second, projects, request } = await fixture();
    const completeStream = vi.fn().mockImplementation(async () => {
      if (outcome === "cancel") runner.cancel(request.runId);
      throw new Error("Provider interrupted");
    });
    const runner = new AgentRunner({ completeStream } as unknown as OpenRouterClient, projects, new ApprovalManager(), new BrowserBridge());
    const events: AgentEvent[] = [];
    await runner.run(request, (event) => events.push(event));
    expect(events.at(-1)?.type).toBe(outcome === "cancel" ? "run.cancelled" : "run.error");
    await expect(projects.select({ path: second })).resolves.toMatchObject({ current: { root: second } });
  });

  it("rejects a queued request from an outdated project before contacting the model", async () => {
    const { second, projects, request } = await fixture();
    await projects.select({ path: second });
    const completeStream = vi.fn();
    const runner = new AgentRunner({ completeStream } as unknown as OpenRouterClient, projects, new ApprovalManager(), new BrowserBridge());
    const events: AgentEvent[] = [];
    await runner.run(request, (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "run.error", code: "PROJECT_CHANGED" });
    expect(completeStream).not.toHaveBeenCalled();
  });

  it("reports cancellation rather than success if a provider finishes after Stop", async () => {
    const { second, projects, request } = await fixture();
    const completeStream = vi.fn().mockImplementation(async (input: Parameters<OpenRouterClient["completeStream"]>[0]) => {
      input.onChunk({ content: "First" });
      runner.cancel(request.runId);
      input.onChunk({ content: "Ignored" });
      return { message: { role: "assistant", content: "Late answer" }, finishReason: "stop" };
    });
    const runner = new AgentRunner({ completeStream } as unknown as OpenRouterClient, projects, new ApprovalManager(), new BrowserBridge());
    const events: AgentEvent[] = [];
    await runner.run(request, (event) => events.push(event));
    expect(events.map((event) => event.type)).toEqual(["run.started", "assistant.delta", "run.cancelled"]);
    await expect(projects.select({ path: second })).resolves.toMatchObject({ current: { root: second } });
  });

  it("does not let runs start while a project selection is in progress", async () => {
    const { second, projects, request } = await fixture();
    const selecting = projects.select({ path: second });
    const completeStream = vi.fn();
    const runner = new AgentRunner({ completeStream } as unknown as OpenRouterClient, projects, new ApprovalManager(), new BrowserBridge());
    const events: AgentEvent[] = [];
    await runner.run(request, (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "run.error", code: "PROJECT_CHANGING" });
    expect(completeStream).not.toHaveBeenCalled();
    await selecting;
  });
});
