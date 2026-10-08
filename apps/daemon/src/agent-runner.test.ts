import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEvent, AgentRunRequest } from "@browser-agent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "./agent-runner.js";
import { ApprovalManager } from "./approval-manager.js";
import { BrowserBridge } from "./browser-bridge.js";
import { CodebaseMapFeature } from "./codebase-map/index.js";
import * as errors from "./errors.js";
import type { OpenRouterClient } from "./openrouter.js";
import { ProjectService } from "./project-service.js";
import { ProjectStore } from "./project-store.js";

const temporaryDirectories: string[] = [];

function codebaseMapWasmDirectory(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@vscode/tree-sitter-wasm"));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AgentRunner", () => {
  it("executes a model-requested read tool and completes the conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-agent-runner-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "runner-fixture" }));
    await writeFile(join(root, "note.txt"), "fixture contents\n");

    const projects = new ProjectService(new ProjectStore(join(root, ".state.json")));
    await projects.select({ path: root });

    const completeStream = vi.fn()
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-read",
            type: "function",
            function: { name: "fs_read", arguments: JSON.stringify({ path: "note.txt" }) },
          }],
        },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: "I read the fixture.", tool_calls: [] },
        finishReason: "stop",
      });
    const openRouter = { completeStream } as unknown as OpenRouterClient;
    const runner = new AgentRunner(
      openRouter,
      projects,
      new ApprovalManager(),
      new BrowserBridge(),
    );
    const events: AgentEvent[] = [];
    const request: AgentRunRequest = {
      runId: "run-fixture",
      sessionId: "session-fixture",
      model: "provider/model",
      messages: [{ role: "user", content: "Read note.txt" }],
      context: { elements: [], visualChanges: [], attachments: [] },
      approvalMode: "ask",
    };

    await runner.run(request, (event) => events.push(event));

    expect(completeStream).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "tool.started",
      "tool.finished",
      "assistant.delta",
      "assistant.message",
      "run.completed",
    ]);
    const secondRequest = completeStream.mock.calls[1]?.[0] as { messages: Array<Record<string, unknown>> };
    const toolMessage = secondRequest.messages.find((message) => message.role === "tool");
    expect(toolMessage).toMatchObject({
      role: "tool",
      tool_call_id: "call-read",
    });
    expect(String(toolMessage?.content)).toContain("fixture contents");
  });

  it("snapshots codebase-map availability for a run and hides it from the next run after disabling", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-agent-runner-map-project-"));
    const cache = await mkdtemp(join(tmpdir(), "browser-agent-runner-map-cache-"));
    temporaryDirectories.push(root, cache);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "runner-map-fixture" }));
    await writeFile(join(root, "service.ts"), "export function greet(): string { return 'hello'; }\n");

    const projects = new ProjectService(new ProjectStore(join(root, ".state.json")));
    await projects.select({ path: root });
    const feature = new CodebaseMapFeature({
      cacheDirectory: cache,
      wasmDirectory: codebaseMapWasmDirectory(),
      enabled: true,
    });
    const requests: Array<{ messages: Array<Record<string, unknown>>; tools: Array<{ function: { name: string } }> }> = [];
    const completeStream = vi.fn().mockImplementation(async (input: {
      messages: Array<Record<string, unknown>>;
      tools: Array<{ function: { name: string } }>;
    }) => {
      requests.push(input);
      if (requests.length === 1) {
        feature.setEnabled(false);
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-map",
              type: "function",
              function: { name: "codebase_map", arguments: JSON.stringify({ action: "project_overview" }) },
            }],
          },
          finishReason: "tool_calls",
        };
      }
      return {
        message: {
          role: "assistant",
          content: requests.length === 2 ? "Mapped the project." : "Mapping is off.",
          tool_calls: [],
        },
        finishReason: "stop",
      };
    });
    const runner = new AgentRunner(
      { completeStream } as unknown as OpenRouterClient,
      projects,
      new ApprovalManager(),
      new BrowserBridge(),
      feature,
    );

    try {
      const firstRunEvents: AgentEvent[] = [];
      await runner.run({
        runId: "run-map-enabled",
        sessionId: "session-map",
        model: "provider/model",
        messages: [{ role: "user", content: "Map this project" }],
        context: { elements: [], visualChanges: [], attachments: [] },
        approvalMode: "ask",
      }, (event) => firstRunEvents.push(event));

      expect(requests[0]?.tools.map((tool) => tool.function.name)).toContain("codebase_map");
      expect(String(requests[0]?.messages[0]?.content)).toContain("persistent structural codebase map");
      expect(firstRunEvents.find((event) => event.type === "tool.finished")).toMatchObject({
        type: "tool.finished",
        name: "codebase_map",
      });
      expect(firstRunEvents.some((event) => event.type === "run.error")).toBe(false);

      const secondRunEvents: AgentEvent[] = [];
      await runner.run({
        runId: "run-map-disabled",
        sessionId: "session-map",
        model: "provider/model",
        messages: [{ role: "user", content: "Map this project again" }],
        context: { elements: [], visualChanges: [], attachments: [] },
        approvalMode: "ask",
      }, (event) => secondRunEvents.push(event));

      expect(requests[2]?.tools.map((tool) => tool.function.name)).not.toContain("codebase_map");
      expect(String(requests[2]?.messages[0]?.content)).not.toContain("persistent structural codebase map");
      expect(secondRunEvents.some((event) => event.type === "run.error")).toBe(false);
    } finally {
      feature.dispose();
    }
  });

  it.each([null, "   \n\t"])(
    "reports an actionable error when the model returns empty content (%j)",
    async (content) => {
      const observedErrors: unknown[] = [];
      const originalErrorMessage = errors.errorMessage;
      vi.spyOn(errors, "errorMessage").mockImplementation((error) => {
        observedErrors.push(error);
        return originalErrorMessage(error);
      });
      const root = await mkdtemp(join(tmpdir(), "browser-agent-empty-response-"));
      temporaryDirectories.push(root);
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "empty-response-fixture" }));

      const projects = new ProjectService(new ProjectStore(join(root, ".state.json")));
      await projects.select({ path: root });
      const completeStream = vi.fn().mockResolvedValue({
        message: { role: "assistant", content, tool_calls: [] },
        finishReason: "stop",
      });
      const runner = new AgentRunner(
        { completeStream } as unknown as OpenRouterClient,
        projects,
        new ApprovalManager(),
        new BrowserBridge(),
      );
      const events: AgentEvent[] = [];

      await runner.run({
        runId: `run-empty-${content === null ? "null" : "blank"}`,
        sessionId: "session-empty",
        model: "provider/model",
        messages: [{ role: "user", content: "Make a change" }],
        context: { elements: [], visualChanges: [], attachments: [] },
        approvalMode: "ask",
      }, (event) => events.push(event));

      expect(completeStream).toHaveBeenCalledTimes(1);
      expect(events.map((event) => event.type)).toEqual(["run.started", "run.error"]);
      expect(events[1]).toMatchObject({
        type: "run.error",
        error: "The selected model returned an empty response. Retry the request or choose a different tool-capable model.",
      });
      expect(observedErrors[0]).toBeInstanceOf(errors.AppError);
      expect(observedErrors[0]).toMatchObject({
        code: "MODEL_RESPONSE_EMPTY",
        status: 502,
        details: { model: "provider/model", finishReason: "stop" },
      });
      expect(runner.has(`run-empty-${content === null ? "null" : "blank"}`)).toBe(false);
    },
  );

  it("emits incremental thinking and answer chunks without duplicating the final response", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-agent-streaming-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "streaming-fixture" }));

    const projects = new ProjectService(new ProjectStore(join(root, ".state.json")));
    await projects.select({ path: root });
    const completeStream = vi.fn().mockImplementation(async (input: {
      onChunk: (chunk: { content?: string; reasoning?: string }) => void;
    }) => {
      input.onChunk({ reasoning: "Plan " });
      input.onChunk({ reasoning: "carefully." });
      input.onChunk({ content: "Hel" });
      input.onChunk({ content: "lo" });
      return {
        message: { role: "assistant", content: "Hello", tool_calls: [] },
        finishReason: "stop",
      };
    });
    const runner = new AgentRunner(
      { completeStream } as unknown as OpenRouterClient,
      projects,
      new ApprovalManager(),
      new BrowserBridge(),
    );
    const events: AgentEvent[] = [];

    await runner.run({
      runId: "run-streaming",
      sessionId: "session-streaming",
      model: "provider/model",
      messages: [{ role: "user", content: "Say hello" }],
      context: { elements: [], visualChanges: [], attachments: [] },
      approvalMode: "ask",
    }, (event) => events.push(event));

    expect(events.filter((event) => event.type === "assistant.thinking").map((event) => event.delta)).toEqual([
      "Plan ",
      "carefully.",
    ]);
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.delta)).toEqual([
      "Hel",
      "lo",
    ]);
    expect(events.find((event) => event.type === "assistant.message")).toMatchObject({ content: "Hello" });
  });

  it("releases the run when initial event delivery fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-agent-emit-failure-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "emit-failure-fixture" }));
    const projects = new ProjectService(new ProjectStore(join(root, ".state.json")));
    await projects.select({ path: root });
    const completeStream = vi.fn();
    const runner = new AgentRunner(
      { completeStream } as unknown as OpenRouterClient,
      projects,
      new ApprovalManager(),
      new BrowserBridge(),
    );
    const events: AgentEvent[] = [];
    let deliveryCount = 0;

    await runner.run({
      runId: "run-emit-failure",
      sessionId: "session-emit-failure",
      model: "provider/model",
      messages: [{ role: "user", content: "Hello" }],
      context: { elements: [], visualChanges: [], attachments: [] },
      approvalMode: "ask",
    }, (event) => {
      deliveryCount += 1;
      if (deliveryCount === 1) throw new Error("Event transport closed");
      events.push(event);
    });

    expect(completeStream).not.toHaveBeenCalled();
    expect(events).toMatchObject([{ type: "run.error", error: "Event transport closed" }]);
    expect(runner.has("run-emit-failure")).toBe(false);
  });
});
