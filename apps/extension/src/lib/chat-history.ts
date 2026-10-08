import type { ChatMessage } from "./types";

export const CHAT_HISTORY_STORAGE_KEY = "browserAgent.chatHistory.v1";
export const LEGACY_CHAT_STORAGE_KEY = "browserAgent.chat.v1";

export const CHAT_HISTORY_LIMITS = {
  conversations: 30,
  messagesPerConversation: 200,
  messageCharacters: 50_000,
  conversationCharacters: 400_000,
  totalCharacters: 2_000_000,
  titleCharacters: 72,
} as const;

const HISTORY_VERSION = 1 as const;
const INTERRUPTED_EMPTY_MESSAGE = "This response was interrupted when the side panel closed.";
const INTERRUPTED_SUFFIX = "\n\nResponse interrupted when the side panel closed.";

export interface ChatConversation {
  id: string;
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  pendingAssistantId: string | null;
}

export interface ChatHistoryState {
  version: typeof HISTORY_VERSION;
  activeConversationId: string;
  conversations: ChatConversation[];
}

interface NormalizeOptions {
  now?: number;
  recoverInterrupted?: boolean;
}

export function createChatHistory(now = Date.now()): ChatHistoryState {
  const conversation = createConversation(now);
  return {
    version: HISTORY_VERSION,
    activeConversationId: conversation.id,
    conversations: [conversation],
  };
}

export function getActiveConversation(history: ChatHistoryState): ChatConversation {
  return history.conversations.find((conversation) => conversation.id === history.activeConversationId)
    ?? history.conversations[0]
    ?? createConversation();
}

export function updateActiveConversation(
  history: ChatHistoryState,
  messages: readonly ChatMessage[],
  pendingAssistantId: string | null,
  now = Date.now(),
): ChatHistoryState {
  const active = getActiveConversation(history);
  const boundedMessages = normalizeMessages(messages, pendingAssistantId);
  const boundedPendingId = pendingAssistantId && boundedMessages.some(
    (message) => message.id === pendingAssistantId && message.role === "assistant",
  ) ? pendingAssistantId : null;

  if (sameMessages(active.messages, boundedMessages) && active.pendingAssistantId === boundedPendingId) {
    return history;
  }

  const nextActive: ChatConversation = {
    ...active,
    title: titleFromMessages(boundedMessages),
    updatedAt: Math.max(active.createdAt, finiteTimestamp(now, active.updatedAt)),
    messages: boundedMessages,
    pendingAssistantId: boundedPendingId,
  };
  return compactHistory({
    ...history,
    conversations: history.conversations.map((conversation) => (
      conversation.id === active.id ? nextActive : conversation
    )),
  });
}

export function startNewConversation(history: ChatHistoryState, now = Date.now()): ChatHistoryState {
  const conversation = createConversation(now);
  return compactHistory({
    version: HISTORY_VERSION,
    activeConversationId: conversation.id,
    conversations: [
      conversation,
      ...history.conversations.filter((candidate) => candidate.messages.length > 0),
    ],
  });
}

export function selectConversation(history: ChatHistoryState, id: string): ChatHistoryState {
  if (id === history.activeConversationId || !history.conversations.some((conversation) => conversation.id === id)) {
    return history;
  }
  return { ...history, activeConversationId: id };
}

export function deleteConversation(history: ChatHistoryState, id: string, now = Date.now()): ChatHistoryState {
  const remaining = history.conversations.filter((conversation) => conversation.id !== id);
  if (!remaining.length) return createChatHistory(now);
  const activeConversationId = id === history.activeConversationId
    || !remaining.some((conversation) => conversation.id === history.activeConversationId)
    ? [...remaining].sort((left, right) => right.updatedAt - left.updatedAt)[0]!.id
    : history.activeConversationId;
  return compactHistory({ ...history, activeConversationId, conversations: remaining });
}

export async function clearChatHistory(): Promise<void> {
  try {
    await chrome.storage.local.remove([CHAT_HISTORY_STORAGE_KEY, LEGACY_CHAT_STORAGE_KEY]);
  } catch {
    // History controls remain usable when storage is temporarily unavailable.
  }
}

export function normalizeChatHistory(value: unknown, options: NormalizeOptions = {}): ChatHistoryState {
  const now = finiteTimestamp(options.now, Date.now());
  if (!isRecord(value) || value.version !== HISTORY_VERSION || !Array.isArray(value.conversations)) {
    return createChatHistory(now);
  }

  const conversations: ChatConversation[] = [];
  const conversationIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const candidate of value.conversations) {
    const conversation = normalizeConversation(candidate, now, options.recoverInterrupted === true);
    if (!conversation) continue;
    if (conversationIds.has(conversation.id)) conversation.id = randomId();
    if (sessionIds.has(conversation.sessionId)) conversation.sessionId = randomId();
    conversationIds.add(conversation.id);
    sessionIds.add(conversation.sessionId);
    conversations.push(conversation);
  }

  if (!conversations.length) return createChatHistory(now);
  const requestedActiveId = safeIdentifier(value.activeConversationId);
  const activeConversationId = requestedActiveId && conversations.some((conversation) => conversation.id === requestedActiveId)
    ? requestedActiveId
    : conversations[0]!.id;

  return compactHistory({ version: HISTORY_VERSION, activeConversationId, conversations });
}

export async function loadChatHistory(): Promise<ChatHistoryState> {
  const now = Date.now();
  try {
    const stored = await chrome.storage.local.get([CHAT_HISTORY_STORAGE_KEY, LEGACY_CHAT_STORAGE_KEY]);
    const current = stored[CHAT_HISTORY_STORAGE_KEY];
    const history = isVersionedHistory(current)
      ? normalizeChatHistory(current, { now, recoverInterrupted: true })
      : migrateLegacyChat(stored[LEGACY_CHAT_STORAGE_KEY], now) ?? createChatHistory(now);

    await chrome.storage.local.set({ [CHAT_HISTORY_STORAGE_KEY]: history });
    if (!isVersionedHistory(current) && stored[LEGACY_CHAT_STORAGE_KEY] !== undefined) {
      await chrome.storage.local.remove(LEGACY_CHAT_STORAGE_KEY);
    }
    return history;
  } catch {
    return createChatHistory(now);
  }
}

export async function saveChatHistory(history: ChatHistoryState): Promise<ChatHistoryState> {
  const normalized = normalizeChatHistory(history);
  try {
    await chrome.storage.local.set({ [CHAT_HISTORY_STORAGE_KEY]: normalized });
  } catch {
    // Chat history is best-effort and must never prevent the user from chatting.
  }
  return normalized;
}

function createConversation(now = Date.now()): ChatConversation {
  const timestamp = finiteTimestamp(now, Date.now());
  return {
    id: randomId(),
    sessionId: randomId(),
    title: "New task",
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    pendingAssistantId: null,
  };
}

function normalizeConversation(value: unknown, now: number, recoverInterrupted: boolean): ChatConversation | null {
  if (!isRecord(value)) return null;
  const id = safeIdentifier(value.id) ?? randomId();
  const sessionId = safeIdentifier(value.sessionId) ?? randomId();
  const createdAt = finiteTimestamp(value.createdAt, now);
  const updatedAt = Math.max(createdAt, finiteTimestamp(value.updatedAt, createdAt));
  const requestedPendingId = safeIdentifier(value.pendingAssistantId);
  let messages = normalizeMessages(Array.isArray(value.messages) ? value.messages : [], requestedPendingId);
  let pendingAssistantId = requestedPendingId && messages.some(
    (message) => message.id === requestedPendingId && message.role === "assistant",
  ) ? requestedPendingId : null;

  if (recoverInterrupted && pendingAssistantId) {
    messages = messages.map((message) => {
      if (message.id !== pendingAssistantId) return message;
      return {
        ...message,
        content: message.content.trim()
          ? appendInterruptedSuffix(message.content)
          : INTERRUPTED_EMPTY_MESSAGE,
      };
    });
    pendingAssistantId = null;
  }

  if (!pendingAssistantId) {
    messages = messages.filter((message) => message.role !== "assistant" || Boolean(message.content.trim()));
  }

  const storedTitle = safeText(value.title, CHAT_HISTORY_LIMITS.titleCharacters);
  return {
    id,
    sessionId,
    title: storedTitle || titleFromMessages(messages),
    createdAt,
    updatedAt,
    messages,
    pendingAssistantId,
  };
}

function normalizeMessages(values: readonly unknown[], pendingAssistantId: string | null): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    if (!isRecord(value) || !isChatRole(value.role) || typeof value.content !== "string") continue;
    let id = safeIdentifier(value.id) ?? randomId();
    if (ids.has(id)) id = randomId();
    ids.add(id);
    const content = truncate(value.content, CHAT_HISTORY_LIMITS.messageCharacters);
    if (!content.trim() && !(value.role === "assistant" && id === pendingAssistantId)) continue;
    normalized.push({ id, role: value.role, content });
  }

  const kept: ChatMessage[] = [];
  let characters = 0;
  for (let index = normalized.length - 1; index >= 0 && kept.length < CHAT_HISTORY_LIMITS.messagesPerConversation; index -= 1) {
    const message = normalized[index];
    if (!message) continue;
    const remaining = CHAT_HISTORY_LIMITS.conversationCharacters - characters;
    if (remaining <= 0) break;
    const content = truncate(message.content, remaining);
    kept.push({ ...message, content });
    characters += content.length;
  }
  return kept.reverse();
}

function compactHistory(history: ChatHistoryState): ChatHistoryState {
  const active = history.conversations.find((conversation) => conversation.id === history.activeConversationId)
    ?? history.conversations[0]
    ?? createConversation();
  const newest = [...history.conversations]
    .filter((conversation) => conversation.id === active.id || conversation.messages.length > 0)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
  const priority = [active, ...newest.filter((conversation) => conversation.id !== active.id)];
  const kept: ChatConversation[] = [];
  let totalCharacters = 0;

  for (const conversation of priority) {
    if (kept.length >= CHAT_HISTORY_LIMITS.conversations) break;
    const characters = conversation.messages.reduce((total, message) => total + message.content.length, 0);
    if (conversation.id !== active.id && totalCharacters + characters > CHAT_HISTORY_LIMITS.totalCharacters) continue;
    kept.push(conversation);
    totalCharacters += characters;
  }

  kept.sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
  return {
    version: HISTORY_VERSION,
    activeConversationId: active.id,
    conversations: kept,
  };
}

function migrateLegacyChat(value: unknown, now: number): ChatHistoryState | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) return null;
  const history = createChatHistory(now);
  const active = getActiveConversation(history);
  const sessionId = safeIdentifier(value.sessionId) ?? active.sessionId;
  const migrated: ChatHistoryState = {
    ...history,
    conversations: [{
      ...active,
      sessionId,
      messages: normalizeMessages(value.messages, null),
      pendingAssistantId: null,
    }],
  };
  const conversation = migrated.conversations[0]!;
  conversation.title = titleFromMessages(conversation.messages);
  return compactHistory(migrated);
}

function titleFromMessages(messages: readonly ChatMessage[]): string {
  const source = messages.find((message) => message.role === "user" && message.content.trim())
    ?? messages.find((message) => message.content.trim());
  if (!source) return "New task";
  return truncate(source.content.replace(/\s+/g, " ").trim(), CHAT_HISTORY_LIMITS.titleCharacters);
}

function appendInterruptedSuffix(content: string): string {
  return content.endsWith(INTERRUPTED_SUFFIX) ? content : truncate(
    `${content}${INTERRUPTED_SUFFIX}`,
    CHAT_HISTORY_LIMITS.messageCharacters,
  );
}

function sameMessages(left: readonly ChatMessage[], right: readonly ChatMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => {
    const candidate = right[index];
    return candidate?.id === message.id && candidate.role === message.role && candidate.content === message.content;
  });
}

function isVersionedHistory(value: unknown): boolean {
  return isRecord(value) && value.version === HISTORY_VERSION && Array.isArray(value.conversations);
}

function isChatRole(value: unknown): value is ChatMessage["role"] {
  return value === "user" || value === "assistant" || value === "system";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 200 ? trimmed : null;
}

function safeText(value: unknown, limit: number): string {
  return typeof value === "string" ? truncate(value.replace(/\s+/g, " ").trim(), limit) : "";
}

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
