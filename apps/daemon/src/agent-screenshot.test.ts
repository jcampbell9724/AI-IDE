import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@browser-agent/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "./agent-runner.js";
import { ApprovalManager } from "./approval-manager.js";
import { BrowserBridge } from "./browser-bridge.js";
import type { OpenRouterClient } from "./openrouter.js";
import { ProjectService } from "./project-service.js";
import { ProjectStore } from "./project-store.js";

describe("agent screenshots", () => {
  it.each([true, false])("handles a model with image support=%s", async (supported) => {
    const root = await mkdtemp(join(tmpdir(), "agent-screenshot-"));
    try {
      const projects = new ProjectService(new ProjectStore(join(root, "state.json")));
      await projects.select({ path: root });
      const bridge = new BrowserBridge();
      const dataUrl = "data:image/png;base64," + "A".repeat(600_000);
      const requests: Array<Array<Record<string, unknown>>> = [];
      const completeStream = vi.fn().mockImplementation(async (input: Parameters<OpenRouterClient["completeStream"]>[0]) => {
        requests.push(structuredClone(input.messages));
        return requests.length === 1 ? {
          message: { role: "assistant", content: null, tool_calls: [
            { id: "shot", type: "function", function: { name: "browser", arguments: '{"action":"screenshot","arguments":{}}' } },
            { id: "list", type: "function", function: { name: "fs_list", arguments: '{}' } },
          ] }, finishReason: "tool_calls",
        } : { message: { role: "assistant", content: "Done" }, finishReason: "stop" };
      });
      const runner = new AgentRunner({ completeStream, supportsImageInput: vi.fn().mockResolvedValue(supported) } as unknown as OpenRouterClient, projects, new ApprovalManager(), bridge);
      const events: AgentEvent[] = [];
      await runner.run({
        runId: "screenshot", sessionId: "session", model: "test/model",
        messages: [{ role: "user", content: "Inspect the page" }],
        context: { elements: [], visualChanges: [], attachments: [] }, approvalMode: "ask",
      }, (event) => {
        events.push(event);
        if (event.type === "browser.request") bridge.resolve(event.request.id, { result: { dataUrl, tab: { id: 1 } } });
      });
      const followup = requests[1]!;
      const tool = followup.find((message) => message.tool_call_id === "shot")!;
      expect(String(tool.content)).not.toContain(dataUrl);
      if (supported) {
        expect(followup.slice(-3).map((message) => message.role)).toEqual(["tool", "tool", "user"]);
        const parts = followup.at(-1)!.content as Array<Record<string, unknown>>;
        expect(parts.find((part) => part.type === "image_url")).toEqual({ type: "image_url", image_url: { url: dataUrl } });
        expect(JSON.parse(String(tool.content))).toMatchObject({ result: { imageAttached: true } });
      } else {
        expect(events.some((event) => event.type === "browser.request")).toBe(false);
        expect(String(tool.content)).toContain("cannot inspect screenshots");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
