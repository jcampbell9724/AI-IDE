import { describe, expect, it } from "vitest";
import { applyAssistantTextEvent, applyCompletedAssistantText } from "./message-stream";

const base = { runId: "run-1", timestamp: "2026-08-30T20:00:00.000Z" };

describe("assistant streaming text", () => {
  it("appends delta fragments in arrival order", () => {
    let messages = [{ id: "assistant-1", content: "" }];
    messages = applyAssistantTextEvent(messages, "assistant-1", { ...base, type: "assistant.delta", delta: "Hel" });
    messages = applyAssistantTextEvent(messages, "assistant-1", { ...base, type: "assistant.delta", delta: "lo" });
    expect(messages[0]?.content).toBe("Hello");
  });

  it("uses the final assistant message as the authoritative text", () => {
    const messages = applyAssistantTextEvent(
      [{ id: "assistant-1", content: "Partial" }],
      "assistant-1",
      { ...base, type: "assistant.message", content: "Complete response" },
    );
    expect(messages[0]?.content).toBe("Complete response");
  });

  it("does not modify a message from another run", () => {
    const messages = applyAssistantTextEvent(
      [{ id: "assistant-2", content: "Keep me" }],
      "assistant-1",
      { ...base, type: "assistant.delta", delta: "Ignored" },
    );
    expect(messages[0]?.content).toBe("Keep me");
  });

  it("uses terminal completion text even after a partial stream", () => {
    const messages = applyCompletedAssistantText(
      [{ id: "assistant-1", content: "Partial stream" }],
      "assistant-1",
      "Authoritative completion",
    );
    expect(messages[0]?.content).toBe("Authoritative completion");
  });
});
