import { describe, expect, it } from "vitest";
import { createChat, createEmptyChatHistory, getActiveChat, getComposerDraft, updateComposerDraft, selectChat, loadProjectChatHistory, saveProjectChatHistory, type StorageLike } from "./persist";
import { prepareChatSubmission } from "./chat-submission";

function memory(): StorageLike {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
}

describe("unsent chat drafts", () => {
  it("adopts the first draft when the user explicitly creates a chat", () => {
    const pending = updateComposerDraft(createEmptyChatHistory(), "Keep this first draft");
    const history = createChat(pending);
    expect(getComposerDraft(history)).toBe("Keep this first draft");
    expect(history.pendingDraft).toBeUndefined();
    expect(history.chats).toHaveLength(1);
  });
  it("retains draft-only chats when creating and switching conversations", () => {
    let history = updateComposerDraft(createChat(createEmptyChatHistory(), { id: "one" }), "  First draft\n");
    history = updateComposerDraft(createChat(history, { id: "two" }), "Second draft");
    expect(history.chats).toHaveLength(2);
    expect(getComposerDraft(selectChat(history, "one"))).toBe("  First draft\n");
    expect(getComposerDraft(selectChat(history, "two"))).toBe("Second draft");
    expect(getActiveChat(history)?.messages).toEqual([]);
  });

  it("persists drafts across reopening and keeps projects separate", () => {
    const store = memory();
    saveProjectChatHistory("alpha", updateComposerDraft(createChat(createEmptyChatHistory()), "Alpha draft"), store);
    saveProjectChatHistory("beta", updateComposerDraft(createChat(createEmptyChatHistory()), "Beta draft"), store);
    expect(getComposerDraft(loadProjectChatHistory("alpha", store))).toBe("Alpha draft");
    expect(getComposerDraft(loadProjectChatHistory("beta", store))).toBe("Beta draft");
  });

  it("keeps the draft before a first chat exists, and clears it only on submission", () => {
    const store = memory();
    const history = updateComposerDraft(createEmptyChatHistory(), "My first message");
    saveProjectChatHistory("alpha", history, store);
    const loaded = loadProjectChatHistory("alpha", store);
    expect(loaded.chats).toHaveLength(0);
    expect(getComposerDraft(loaded)).toBe("My first message");
    const submission = prepareChatSubmission(loaded, getComposerDraft(loaded))!;
    expect(getComposerDraft(submission.history)).toBe("");
    expect(submission.history.pendingDraft).toBeUndefined();
    expect(submission.requestMessages[0]?.content).toBe("My first message");
  });

  it("sending one draft does not clear a different conversation's draft", () => {
    let history = updateComposerDraft(createChat(createEmptyChatHistory(), { id: "one" }), "Keep me");
    history = updateComposerDraft(createChat(history, { id: "two" }), "Send me");
    const submitted = prepareChatSubmission(history, getComposerDraft(history))!;
    expect(getComposerDraft(submitted.history)).toBe("");
    expect(getComposerDraft(selectChat(submitted.history, "one"))).toBe("Keep me");
  });
});
