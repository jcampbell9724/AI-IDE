import type { AgentEvent } from "@browser-agent/shared";

type AssistantTextEvent = Extract<AgentEvent, { type: "assistant.delta" | "assistant.message" }>;

export function applyAssistantTextEvent<T extends { id: string; content: string }>(
  messages: T[],
  assistantId: string,
  event: AssistantTextEvent,
): T[] {
  return messages.map((message) => {
    if (message.id !== assistantId) return message;
    return {
      ...message,
      content: event.type === "assistant.delta"
        ? `${message.content}${event.delta}`
        : event.content,
    };
  });
}

export function applyCompletedAssistantText<T extends { id: string; content: string }>(
  messages: T[],
  assistantId: string,
  content: string,
): T[] {
  return messages.map((message) => message.id === assistantId ? { ...message, content } : message);
}
