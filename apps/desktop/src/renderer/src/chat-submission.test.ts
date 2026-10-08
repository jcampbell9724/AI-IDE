import { describe, expect, it } from "vitest";
import { prepareChatSubmission } from "./chat-submission";
import { createChat, createEmptyChatHistory, getActiveChat, updateActiveChat } from "./persist";

describe("send without selecting a chat", () => {
  it("creates a chat and sends the first message using that chat's session", () => {
    const result = prepareChatSubmission(createEmptyChatHistory(), "  Help with my project  ")!;
    const chat = getActiveChat(result.history)!;
    expect(result.history.chats).toHaveLength(1);
    expect(result.sessionId).toBe(chat.sessionId);
    expect(chat.title).toBe("Help with my project");
    expect(result.requestMessages).toEqual([expect.objectContaining({ role: "user", content: "Help with my project" })]);
    expect(chat.messages[1]).toMatchObject({ id: result.assistantId, role: "assistant", content: "" });
  });

  it("keeps previous conversations isolated when none is selected", () => {
    const old = updateActiveChat(createChat(createEmptyChatHistory()), { messages: [{ id: "old", role: "user", content: "Previous work" }] });
    const oldChat = getActiveChat(old)!;
    const result = prepareChatSubmission({ ...old, activeChatId: null }, "New work")!;
    expect(result.history.chats).toHaveLength(2);
    expect(result.sessionId).not.toBe(oldChat.sessionId);
    expect(result.requestMessages).toHaveLength(1);
    expect(result.history.chats.find((chat) => chat.id === oldChat.id)).toEqual(oldChat);
  });

  it("continues the selected conversation without creating another", () => {
    const old = updateActiveChat(createChat(createEmptyChatHistory()), { messages: [{ id: "old", role: "user", content: "Previous work" }] });
    const result = prepareChatSubmission(old, "Continue")!;
    expect(result.history.chats).toHaveLength(1);
    expect(result.sessionId).toBe(getActiveChat(old)!.sessionId);
    expect(result.requestMessages.map((message) => message.content)).toEqual(["Previous work", "Continue"]);
  });

  it("does not create a chat for an empty submission", () => {
    expect(prepareChatSubmission(createEmptyChatHistory(), " \n ")).toBeNull();
  });
});
