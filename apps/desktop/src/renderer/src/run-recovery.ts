import type { AgentEvent } from "@browser-agent/shared";
import type { AgentErrorInfo } from "./format";
import { getActiveChat, updateActiveChat, type PersistedChatHistory } from "./persist";
import type { prepareChatSubmission } from "./chat-submission";

export type ChatSubmission = NonNullable<ReturnType<typeof prepareChatSubmission>>;

export interface RunAttempt {
  projectPath: string;
  chatId: string;
  assistantId: string;
  userMessageId: string;
  prompt: string;
  activity: boolean;
  output: boolean;
}

export interface FailedRun extends RunAttempt {
  error: AgentErrorInfo;
  confirmedEnded: boolean;
}

export function trackRecoveryEvent(attempt: RunAttempt, event: AgentEvent): void {
  if (["tool.started", "tool.finished", "approval.required", "browser.request"].includes(event.type)) attempt.activity = true;
  if (event.type === "assistant.delta" && event.delta.trim()) attempt.output = true;
  if (event.type === "assistant.message" && event.content.trim()) attempt.output = true;
}

export function canRetryRun(failure: FailedRun, history: PersistedChatHistory, projectPath: string | null): boolean {
  const chat = getActiveChat(history);
  const messages = chat?.messages.filter((message) => message.id !== failure.assistantId) ?? [];
  return failure.error.retryable && failure.confirmedEnded && !failure.activity && !failure.output
    && !chat?.tools.length && !chat?.messages.some((message) => message.id === failure.assistantId && message.content.trim())
    && projectPath === failure.projectPath && chat?.id === failure.chatId
    && messages.at(-1)?.id === failure.userMessageId;
}

export function prepareRunRetry(failure: FailedRun, history: PersistedChatHistory, projectPath: string | null): ChatSubmission | null {
  if (!canRetryRun(failure, history, projectPath)) return null;
  const chat = getActiveChat(history)!;
  const requestMessages = chat.messages.filter((message) => message.id !== failure.assistantId);
  const assistantId = crypto.randomUUID();
  return {
    // Keep the original user message and any new draft; retry only the empty response.
    history: updateActiveChat(history, { messages: [...requestMessages, { id: assistantId, role: "assistant", content: "" }], tools: [] }),
    sessionId: chat.sessionId, assistantId, requestMessages,
  };
}
