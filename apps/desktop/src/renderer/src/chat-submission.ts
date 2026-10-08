import {
  createChat, getActiveChat, updateActiveChat,
  type PersistedChatHistory, type PersistedMessage,
} from "./persist";

/** Branch before the edited request so the original conversation and draft remain available. */
export function prepareEditedMessage(history: PersistedChatHistory, messageId: string, value: string): ReturnType<typeof prepareChatSubmission> {
  const chat = getActiveChat(history);
  const index = chat?.messages.findIndex((message) => message.id === messageId && message.role === "user") ?? -1;
  if (!chat || index < 0 || !value.trim()) return null;
  const branch = updateActiveChat(createChat(history), { messages: chat.messages.slice(0, index) });
  return prepareChatSubmission(branch, value);
}

export function prepareChatSubmission(history: PersistedChatHistory, value: string): {
  history: PersistedChatHistory;
  sessionId: string;
  assistantId: string;
  requestMessages: PersistedMessage[];
} | null {
  const content = value.trim();
  if (!content) return null;
  const selected = getActiveChat(history) ? history : createChat(history);
  const chat = getActiveChat(selected)!;
  const user: PersistedMessage = { id: crypto.randomUUID(), role: "user", content };
  const assistant: PersistedMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };
  const requestMessages = [...chat.messages, user];
  return {
    history: updateActiveChat(getActiveChat(history) ? selected : { ...selected, pendingDraft: "" }, { messages: [...requestMessages, assistant], tools: [], draft: "" }),
    sessionId: chat.sessionId,
    assistantId: assistant.id,
    requestMessages,
  };
}
