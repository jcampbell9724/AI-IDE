import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_HISTORY_LIMITS,
  CHAT_HISTORY_STORAGE_KEY,
  LEGACY_CHAT_STORAGE_KEY,
  clearChatHistory,
  createChatHistory,
  deleteConversation,
  getActiveConversation,
  loadChatHistory,
  normalizeChatHistory,
  selectConversation,
  startNewConversation,
  updateActiveConversation,
} from "./chat-history";
import type { ChatMessage } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extension chat history", () => {
  it("keeps prior conversations and gives each new task its own session", () => {
    let history = createChatHistory(1_000);
    const first = getActiveConversation(history);
    history = updateActiveConversation(history, [message("first", "user", "Fix the header")], null, 1_100);
    history = startNewConversation(history, 2_000);
    const second = getActiveConversation(history);

    expect(second.id).not.toBe(first.id);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(history.conversations).toHaveLength(2);
    expect(history.conversations.find((conversation) => conversation.id === first.id)?.title).toBe("Fix the header");

    history = selectConversation(history, first.id);
    expect(getActiveConversation(history).messages[0]?.content).toBe("Fix the header");
  });

  it("selects a remaining conversation after deletion and clears persisted history", async () => {
    let history = createChatHistory(1_000);
    const firstId = history.activeConversationId;
    history = updateActiveConversation(history, [message("first", "user", "First")], null, 1_100);
    history = startNewConversation(history, 2_000);
    const secondId = history.activeConversationId;
    history = deleteConversation(history, secondId, 3_000);
    expect(history.activeConversationId).toBe(firstId);

    history = deleteConversation(history, firstId, 4_000);
    expect(history.conversations).toHaveLength(1);
    expect(getActiveConversation(history).messages).toEqual([]);

    const remove = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", { storage: { local: { remove } } });
    await clearChatHistory();
    expect(remove).toHaveBeenCalledWith([CHAT_HISTORY_STORAGE_KEY, LEGACY_CHAT_STORAGE_KEY]);
  });

  it("bounds messages, message content, and the number of retained conversations", () => {
    let history = createChatHistory(1);
    const oversized = "x".repeat(CHAT_HISTORY_LIMITS.messageCharacters + 100);
    const messages = Array.from({ length: CHAT_HISTORY_LIMITS.messagesPerConversation + 20 }, (_, index) => (
      message(`message-${index}`, "user", index === 0 ? oversized : `Message ${index}`)
    ));
    history = updateActiveConversation(history, messages, null, 2);

    expect(getActiveConversation(history).messages).toHaveLength(CHAT_HISTORY_LIMITS.messagesPerConversation);
    expect(getActiveConversation(history).messages.every(
      (candidate) => candidate.content.length <= CHAT_HISTORY_LIMITS.messageCharacters,
    )).toBe(true);

    for (let index = 0; index < CHAT_HISTORY_LIMITS.conversations + 8; index += 1) {
      history = startNewConversation(history, 10 + index * 2);
      history = updateActiveConversation(
        history,
        [message(`task-${index}`, "user", `Task ${index}`)],
        null,
        11 + index * 2,
      );
    }
    history = startNewConversation(history, 10_000);

    expect(history.conversations).toHaveLength(CHAT_HISTORY_LIMITS.conversations);
    expect(new Set(history.conversations.map((conversation) => conversation.sessionId)).size).toBe(
      history.conversations.length,
    );
  });

  it("repairs malformed records and duplicate conversation identifiers", () => {
    const history = normalizeChatHistory({
      version: 1,
      activeConversationId: "duplicate",
      conversations: [
        storedConversation("duplicate", "same-session", [message("one", "user", "First")]),
        storedConversation("duplicate", "same-session", [
          { id: "bad", role: "invalid", content: "Ignore me" },
          message("two", "assistant", "Second"),
        ]),
        null,
      ],
    }, { now: 500 });

    expect(history.conversations).toHaveLength(2);
    expect(new Set(history.conversations.map((conversation) => conversation.id)).size).toBe(2);
    expect(new Set(history.conversations.map((conversation) => conversation.sessionId)).size).toBe(2);
    expect(history.conversations.flatMap((conversation) => conversation.messages)).toHaveLength(2);
    expect(history.conversations.some((conversation) => conversation.id === history.activeConversationId)).toBe(true);
  });

  it("turns a persisted in-flight assistant response into an interrupted historical response", () => {
    const partial = normalizeChatHistory({
      version: 1,
      activeConversationId: "partial-chat",
      conversations: [{
        ...storedConversation("partial-chat", "partial-session", [
          message("prompt", "user", "Explain this"),
          message("answer", "assistant", "Partial answer"),
        ]),
        pendingAssistantId: "answer",
      }],
    }, { now: 500, recoverInterrupted: true });
    const partialConversation = getActiveConversation(partial);

    expect(partialConversation.pendingAssistantId).toBeNull();
    expect(partialConversation.messages[1]?.content).toContain("Partial answer");
    expect(partialConversation.messages[1]?.content).toContain("interrupted");

    const empty = normalizeChatHistory({
      version: 1,
      activeConversationId: "empty-chat",
      conversations: [{
        ...storedConversation("empty-chat", "empty-session", [
          message("prompt", "user", "Try this"),
          message("answer", "assistant", ""),
        ]),
        pendingAssistantId: "answer",
      }],
    }, { now: 500, recoverInterrupted: true });

    expect(getActiveConversation(empty).messages[1]?.content).toBe(
      "This response was interrupted when the side panel closed.",
    );
  });

  it("migrates a single-conversation legacy record into versioned local storage", async () => {
    const set = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => ({
            [LEGACY_CHAT_STORAGE_KEY]: {
              sessionId: "legacy-session",
              messages: [message("legacy", "user", "Legacy request")],
            },
          })),
          set,
          remove,
        },
      },
    });

    const history = await loadChatHistory();

    expect(getActiveConversation(history).sessionId).toBe("legacy-session");
    expect(getActiveConversation(history).title).toBe("Legacy request");
    expect(set).toHaveBeenCalledWith({ [CHAT_HISTORY_STORAGE_KEY]: history });
    expect(remove).toHaveBeenCalledWith(LEGACY_CHAT_STORAGE_KEY);
  });

  it("falls back to a usable empty history when extension storage is unavailable", async () => {
    vi.stubGlobal("chrome", {
      storage: { local: { get: vi.fn(async () => { throw new Error("unavailable"); }) } },
    });

    const history = await loadChatHistory();

    expect(history.version).toBe(1);
    expect(history.conversations).toHaveLength(1);
    expect(getActiveConversation(history).messages).toEqual([]);
  });
});

function message(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return { id, role, content };
}

function storedConversation(id: string, sessionId: string, messages: unknown[]): Record<string, unknown> {
  return {
    id,
    sessionId,
    title: "",
    createdAt: 100,
    updatedAt: 200,
    messages,
    pendingAssistantId: null,
  };
}
