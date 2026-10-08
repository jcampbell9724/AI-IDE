import { describe, expect, it } from "vitest";
import { prepareChatSubmission, prepareEditedMessage } from "./chat-submission";
import { getActiveChat, normalizeChatHistory, renameChat, searchChats, updateComposerDraft, createEmptyChatHistory } from "./persist";

describe("chat organization and message editing", () => {
  it("keeps a custom title across sends and persistence", () => {
    const first = prepareChatSubmission(createEmptyChatHistory(), "Original request")!;
    const renamed = renameChat(first.history, first.history.activeChatId!, "  Release plan  ");
    const next = prepareChatSubmission(normalizeChatHistory(renamed), "Continue")!;
    expect(getActiveChat(next.history)?.title).toBe("Release plan");
    expect(renameChat(next.history, next.history.activeChatId!, "  ")).toBe(next.history);
  });
  it("searches names, messages, and drafts without changing selection", () => {
    const first = prepareChatSubmission(createEmptyChatHistory(), "Find the navigation issue")!;
    const history = updateComposerDraft(renameChat(first.history, first.history.activeChatId!, "Polish"), "Check keyboard focus");
    for (const query of ["POLISH", "navigation", "keyboard"]) expect(searchChats(history, query)).toHaveLength(1);
    expect(searchChats(history, "unknown")).toHaveLength(0);
    expect(history.activeChatId).toBe(first.history.activeChatId);
  });
  it("branches before the edited message, preserving the original history and draft", () => {
    const first = prepareChatSubmission(createEmptyChatHistory(), "First request")!;
    const second = prepareChatSubmission(first.history, "Second request")!;
    const original = updateComposerDraft(second.history, "Unsent draft");
    const before = structuredClone(original);
    const edited = prepareEditedMessage(original, second.requestMessages.at(-1)!.id, "Revised second request")!;
    expect(original).toEqual(before);
    expect(edited.sessionId).not.toBe(second.sessionId);
    expect(edited.history.chats.find((chat) => chat.id === original.activeChatId)).toEqual(getActiveChat(original));
    expect(edited.requestMessages.map((message) => message.content)).toEqual(["First request", "", "Revised second request"]);
    expect(getActiveChat(edited.history)?.draft ?? "").toBe("");
    expect(prepareEditedMessage(original, second.assistantId, "Revised")).toBeNull();
    expect(prepareEditedMessage(original, "missing", "Revised")).toBeNull();
    expect(prepareEditedMessage(original, second.requestMessages.at(-1)!.id, "  ")).toBeNull();
  });
});
