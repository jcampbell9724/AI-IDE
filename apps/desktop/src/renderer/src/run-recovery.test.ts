import { describe, expect, it } from "vitest";
import { canRetryRun, prepareRunRetry, trackRecoveryEvent, type FailedRun } from "./run-recovery";
import { prepareChatSubmission } from "./chat-submission";
import { createChat, createEmptyChatHistory, getActiveChat, updateActiveChat, updateComposerDraft } from "./persist";
import { describeAgentError } from "./format";

function failedAttempt() {
  const submission = prepareChatSubmission(createEmptyChatHistory(), "Review my project")!;
  const chat = getActiveChat(submission.history)!;
  const failure: FailedRun = {
    projectPath: "project-a", chatId: chat.id, assistantId: submission.assistantId,
    userMessageId: submission.requestMessages[0]!.id, prompt: "Review my project",
    activity: false, output: false, confirmedEnded: true,
    error: describeAgentError("MODEL_CALL_FAILED", "OpenRouter returned HTTP 503"),
  };
  return { submission, failure };
}

describe("failed request recovery", () => {
  it("retries a confirmed provider failure without duplicating the user's message or clearing their new draft", () => {
    const { submission, failure } = failedAttempt();
    const history = updateComposerDraft(submission.history, "A draft for later");
    const retry = prepareRunRetry(failure, history, "project-a")!;
    expect(retry.requestMessages).toHaveLength(1);
    expect(retry.requestMessages[0]?.id).toBe(failure.userMessageId);
    expect(retry.assistantId).not.toBe(failure.assistantId);
    expect(retry.sessionId).toBe(submission.sessionId);
    expect(getActiveChat(retry.history)?.messages).toHaveLength(2);
    expect(getActiveChat(retry.history)?.draft).toBe("A draft for later");
  });

  it("does not replay after any tool activity, including a failed tool", () => {
    const { submission, failure } = failedAttempt();
    trackRecoveryEvent(failure, { type: "tool.started", runId: "run", timestamp: "2026-09-05T00:00:00Z", toolCallId: "tool", name: "fs_write", arguments: {} });
    expect(canRetryRun(failure, submission.history, "project-a")).toBe(false);
    expect(prepareRunRetry(failure, submission.history, "project-a")).toBeNull();
  });

  it("does not discard a partial assistant response", () => {
    const { submission, failure } = failedAttempt();
    trackRecoveryEvent(failure, { type: "assistant.delta", runId: "run", timestamp: "2026-09-05T00:00:00Z", delta: "Here is my progress" });
    expect(canRetryRun(failure, submission.history, "project-a")).toBe(false);
  });

  it("blocks retries when IPC failure leaves completion uncertain", () => {
    const { submission, failure } = failedAttempt();
    expect(canRetryRun({ ...failure, confirmedEnded: false }, submission.history, "project-a")).toBe(false);
  });

  it("rejects stale recovery actions after changing projects or chats", () => {
    const { submission, failure } = failedAttempt();
    expect(canRetryRun(failure, submission.history, "project-b")).toBe(false);
    expect(canRetryRun(failure, createChat(submission.history), "project-a")).toBe(false);
    const newer = prepareChatSubmission(submission.history, "Another message")!;
    expect(canRetryRun(failure, newer.history, "project-a")).toBe(false);
  });

  it("checks the visible history as well as the event tracker before retrying", () => {
    const { submission, failure } = failedAttempt();
    const history = updateActiveChat(submission.history, { messages: [...submission.requestMessages, { id: submission.assistantId, role: "assistant", content: "Partial response" }] });
    expect(canRetryRun(failure, history, "project-a")).toBe(false);
  });

  it("does not retry non-retryable failures before settings are fixed", () => {
    const { submission, failure } = failedAttempt();
    failure.error = describeAgentError("OPENROUTER_KEY_MISSING", "No key");
    expect(canRetryRun(failure, submission.history, "project-a")).toBe(false);
  });
});

describe("contextual error guidance", () => {
  it.each(["OpenRouter returned HTTP 401", "OpenRouter returned HTTP 403", "Invalid API key"])("offers API-key recovery for %s", (message) => {
    expect(describeAgentError("MODEL_CALL_FAILED", message)).toMatchObject({ recovery: "api-key", retryable: false });
  });
  it("distinguishes exhausted credits from credentials", () => {
    const error = describeAgentError("MODEL_CALL_FAILED", "OpenRouter returned HTTP 402");
    expect(error.title).toBe("Provider credit required");
    expect(error.retryable).toBe(false);
    expect(error.recovery).toBeUndefined();
  });
  it("routes unsupported models and step limits to the appropriate correction", () => {
    expect(describeAgentError("MODEL_VISION_UNSUPPORTED", "Cannot inspect screenshots").recovery).toBe("model");
    expect(describeAgentError("AGENT_STEP_LIMIT", "Limit").recovery).toBe("request");
  });
});
