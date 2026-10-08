import { describe, expect, it } from "vitest";
import {
  CHAT_HISTORY_KEY,
  CHAT_HISTORY_LIMITS,
  LEGACY_CHAT_KEY,
  clearChatHistory,
  createChat,
  createEmptyChatHistory,
  deleteChat,
  deriveChatTitle,
  getActiveChat,
  loadChatHistory,
  loadFavoriteModels,
  loadProjectChatHistory,
  projectChatHistoryKey,
  saveChatHistory,
  saveFavoriteModels,
  saveProjectChatHistory,
  selectChat,
  updateActiveChat,
  type PersistedChatHistory,
  type StorageLike,
} from "./persist";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  failReads = false;
  failWrites = false;

  getItem(key: string): string | null {
    if (this.failReads) throw new Error("read unavailable");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("write unavailable");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failWrites) throw new Error("remove unavailable");
    this.values.delete(key);
  }
}

describe("desktop chat history", () => {
  it("rotates the chat and session even when the current conversation is empty", () => {
    const initial = createChat(createEmptyChatHistory(), { id: "empty", sessionId: "empty-session", now: 1 });
    const next = createChat(initial, { id: "fresh", sessionId: "fresh-session", now: 2 });

    expect(next).toMatchObject({
      activeChatId: "fresh",
      chats: [{ id: "fresh", sessionId: "fresh-session", messages: [] }],
    });
  });

  it("creates, switches, and updates isolated conversations with stable sessions", () => {
    let history = createChat(createEmptyChatHistory(), { id: "chat-a", sessionId: "session-a", now: 1 });
    history = updateActiveChat(history, {
      messages: [{ id: "a-message", role: "user", content: "Build the settings screen" }],
    }, 2);
    history = createChat(history, { id: "chat-b", sessionId: "session-b", now: 3 });
    history = updateActiveChat(history, {
      messages: [{ id: "b-message", role: "user", content: "Fix the browser toolbar" }],
    }, 4);

    expect(getActiveChat(history)).toMatchObject({ id: "chat-b", sessionId: "session-b" });
    history = selectChat(history, "chat-a");
    expect(getActiveChat(history)).toMatchObject({
      id: "chat-a",
      sessionId: "session-a",
      messages: [{ id: "a-message", role: "user", content: "Build the settings screen" }],
    });
    expect(history.chats.find((chat) => chat.id === "chat-b")?.messages[0]?.content).toBe("Fix the browser toolbar");
  });

  it("derives a compact title from the first nonblank user message", () => {
    const title = deriveChatTitle([
      { id: "assistant", role: "assistant", content: "Earlier assistant text" },
      { id: "blank", role: "user", content: "   " },
      { id: "user", role: "user", content: `  Build   a\nnew ${"project ".repeat(20)}` },
    ]);

    expect(title.startsWith("Build a new project")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(CHAT_HISTORY_LIMITS.titleCharacters);
    expect(deriveChatTitle([])).toBe("New chat");
  });

  it("round-trips the current format and prefers it over legacy data", () => {
    const storage = new MemoryStorage();
    let history = createChat(createEmptyChatHistory(), { id: "current", sessionId: "current-session", now: 10 });
    history = updateActiveChat(history, {
      messages: [{ id: "message", role: "user", content: "Current conversation" }],
      tools: [{ id: "tool", name: "read_file", status: "done", summary: "Read it" }],
    }, 11);
    saveChatHistory(history, storage);
    storage.setItem(LEGACY_CHAT_KEY, JSON.stringify({
      sessionId: "legacy-session",
      messages: [{ id: "legacy", role: "user", content: "Legacy conversation" }],
      tools: [],
      lastRun: null,
    }));

    const loaded = loadChatHistory(storage, 20);
    expect(getActiveChat(loaded)).toMatchObject({
      id: "current",
      sessionId: "current-session",
      title: "Current conversation",
    });
    expect(getActiveChat(loaded)?.tools[0]).toMatchObject({ status: "done", summary: "Read it" });
  });

  it("migrates the legacy single chat without losing its transcript or session", () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_CHAT_KEY, JSON.stringify({
      sessionId: "legacy-session",
      messages: [
        { id: "user", role: "user", content: "Continue my saved work" },
        { id: "assistant", role: "assistant", content: "Ready." },
      ],
      tools: [{ id: "tool", name: "shell", status: "done" }],
      lastRun: null,
    }));

    const loaded = loadChatHistory(storage, 50);
    expect(getActiveChat(loaded)).toMatchObject({
      sessionId: "legacy-session",
      title: "Continue my saved work",
      messages: [
        { id: "user", role: "user", content: "Continue my saved work" },
        { id: "assistant", role: "assistant", content: "Ready." },
      ],
    });
    expect(storage.getItem(CHAT_HISTORY_KEY)).not.toBeNull();
    expect(storage.getItem(LEGACY_CHAT_KEY)).toBeNull();
  });

  it("repairs stale runtime tools and a missing active id on reload", () => {
    const storage = new MemoryStorage();
    storage.setItem(CHAT_HISTORY_KEY, JSON.stringify({
      version: 2,
      activeChatId: "missing",
      chats: [{
        id: "saved",
        sessionId: "session",
        title: "Saved",
        createdAt: 10,
        updatedAt: 20,
        messages: [{ id: "message", role: "user", content: "Saved" }],
        tools: [
          { id: "running", name: "shell", status: "running" },
          { id: "approval", approvalId: "approval-id", name: "write_file", status: "approval" },
        ],
        lastRun: null,
      }],
    }));

    const loaded = loadChatHistory(storage, 30);
    expect(loaded.activeChatId).toBe("saved");
    expect(getActiveChat(loaded)?.tools).toEqual([
      { id: "running", name: "shell", status: "failed", summary: "Interrupted when Span closed." },
      { id: "approval", name: "write_file", status: "failed", summary: "Interrupted when Span closed." },
    ]);
  });

  it("bounds chats, messages, and oversized fields", () => {
    const storage = new MemoryStorage();
    const chats: PersistedChatHistory["chats"] = Array.from(
      { length: CHAT_HISTORY_LIMITS.chats + 5 },
      (_, index) => ({
        id: `chat-${index}`,
        sessionId: `session-${index}`,
        title: `Chat ${index}`,
        createdAt: index,
        updatedAt: index,
        messages: Array.from({ length: CHAT_HISTORY_LIMITS.messagesPerChat + 5 }, (__, messageIndex) => ({
          id: `message-${index}-${messageIndex}`,
          role: "user" as const,
          content: messageIndex === CHAT_HISTORY_LIMITS.messagesPerChat + 4 ? "x".repeat(CHAT_HISTORY_LIMITS.fieldCharacters + 100) : "message",
        })),
        tools: [],
        lastRun: null,
      }),
    );

    const saved = saveChatHistory({ activeChatId: "chat-34", chats }, storage);
    expect(saved.chats).toHaveLength(CHAT_HISTORY_LIMITS.chats);
    expect(getActiveChat(saved)?.messages).toHaveLength(CHAT_HISTORY_LIMITS.messagesPerChat);
    expect(getActiveChat(saved)?.messages.at(-1)?.content.length).toBeLessThanOrEqual(CHAT_HISTORY_LIMITS.fieldCharacters);
  });

  it("selects a safe fallback after deletion and closes the final chat", () => {
    let history = createChat(createEmptyChatHistory(), { id: "first", sessionId: "first-session", now: 1 });
    history = updateActiveChat(history, { messages: [{ id: "one", role: "user", content: "One" }] }, 2);
    history = createChat(history, { id: "second", sessionId: "second-session", now: 3 });
    history = deleteChat(history, "second");
    expect(history.activeChatId).toBe("first");

    history = deleteChat(history, "first", { id: "fresh", sessionId: "fresh-session", now: 4 });
    expect(history).toEqual({ activeChatId: null, chats: [] });
  });

  it("never throws for malformed or unavailable storage", () => {
    const malformed = new MemoryStorage();
    malformed.setItem(CHAT_HISTORY_KEY, "not-json");
    malformed.setItem(LEGACY_CHAT_KEY, JSON.stringify({
      sessionId: "recovered-session",
      messages: [{ id: "recovered", role: "user", content: "Recovered legacy chat" }],
      tools: [],
    }));
    expect(getActiveChat(loadChatHistory(malformed, 1))).toMatchObject({
      sessionId: "recovered-session",
      title: "Recovered legacy chat",
    });

    const unavailable = new MemoryStorage();
    unavailable.failReads = true;
    unavailable.failWrites = true;
    expect(() => saveChatHistory(createEmptyChatHistory(), unavailable)).not.toThrow();
    expect(() => clearChatHistory(unavailable)).not.toThrow();
    expect(getActiveChat(loadChatHistory(unavailable, 2))).toBeNull();
  });

  it("restores each project's selected chat without mixing histories", () => {
    const storage = new MemoryStorage();
    let alpha = createChat(createEmptyChatHistory(), { id: "alpha-chat", sessionId: "alpha-session", now: 1 });
    alpha = updateActiveChat(alpha, {
      messages: [{ id: "alpha-message", role: "user", content: "Only in alpha" }],
    }, 2);
    let beta = createChat(createEmptyChatHistory(), { id: "beta-chat", sessionId: "beta-session", now: 3 });
    beta = updateActiveChat(beta, {
      messages: [{ id: "beta-message", role: "user", content: "Only in beta" }],
    }, 4);

    saveProjectChatHistory("C:\\work\\alpha", alpha, storage);
    saveProjectChatHistory("C:\\work\\beta", beta, storage);

    const loadedAlpha = loadProjectChatHistory("C:\\work\\alpha", storage, 10);
    const loadedBeta = loadProjectChatHistory("C:\\work\\beta", storage, 10);
    expect(loadedAlpha.activeChatId).toBe("alpha-chat");
    expect(loadedBeta.activeChatId).toBe("beta-chat");
    expect(loadedAlpha.chats.map((chat) => chat.title)).toEqual(["Only in alpha"]);
    expect(loadedBeta.chats.map((chat) => chat.title)).toEqual(["Only in beta"]);
    expect(projectChatHistoryKey("C:\\work\\alpha")).not.toBe(projectChatHistoryKey("C:\\work\\beta"));
  });

  it("does not load or save chats until a project exists", () => {
    const storage = new MemoryStorage();
    const history = createChat(createEmptyChatHistory(), { id: "draft", sessionId: "draft-session" });

    expect(loadProjectChatHistory(null, storage)).toEqual({ activeChatId: null, chats: [] });
    saveProjectChatHistory(null, history, storage);
    expect(storage.values.size).toBe(0);
  });
});

describe("starred models", () => {
  it("persists starred model ids across settings sessions", () => {
    const storage = new MemoryStorage();

    saveFavoriteModels(["anthropic/claude-sonnet", "openai/gpt-5"], storage);

    expect(loadFavoriteModels(storage)).toEqual([
      "anthropic/claude-sonnet",
      "openai/gpt-5",
    ]);
  });

  it("recovers safely when starred-model storage is malformed or unavailable", () => {
    const malformed = new MemoryStorage();
    malformed.values.set("browser-agent.desktop.favorites.v1", "not-json");
    expect(loadFavoriteModels(malformed)).toEqual([]);

    const unavailable = new MemoryStorage();
    unavailable.failReads = true;
    unavailable.failWrites = true;
    expect(loadFavoriteModels(unavailable)).toEqual([]);
    expect(() => saveFavoriteModels(["openai/gpt-5"], unavailable)).not.toThrow();
  });
});
