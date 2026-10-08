import type { AgentRunRequest } from "@browser-agent/shared";

export const CHAT_HISTORY_KEY = "browser-agent.desktop.chat-history.v2";
export const LEGACY_CHAT_KEY = "browser-agent.desktop.chat.v1";
export const PROJECT_CHAT_HISTORY_KEY_PREFIX = "browser-agent.desktop.project-chat-history.v1";

export const CHAT_HISTORY_LIMITS = {
  chats: 30,
  messagesPerChat: 200,
  toolsPerChat: 400,
  fieldCharacters: 50_000,
  chatCharacters: 450_000,
  totalCharacters: 2_000_000,
  titleCharacters: 64,
} as const;

const FAVORITES_KEY = "browser-agent.desktop.favorites.v1";
const HISTORY_VERSION = 2;
const INTERRUPTED_SUMMARY = "Interrupted when Span closed.";

export interface PersistedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface PersistedTool {
  id: string;
  name: string;
  status: "running" | "approval" | "done" | "failed";
  summary?: string;
  approvalId?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  preview?: string;
  path?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface PersistedRun {
  request: AgentRunRequest;
  assistantId: string;
  at: number;
}

export interface PersistedConversation {
  draft?: string;
  id: string;
  sessionId: string;
  title: string;
  titleIsCustom?: boolean;
  createdAt: number;
  updatedAt: number;
  messages: PersistedMessage[];
  tools: PersistedTool[];
  lastRun: PersistedRun | null;
}

export interface PersistedChatHistory {
  pendingDraft?: string;
  activeChatId: string | null;
  chats: PersistedConversation[];
}

export interface PersistedConversationPatch {
  draft?: string;
  messages?: readonly PersistedMessage[];
  tools?: readonly PersistedTool[];
  sessionId?: string;
  lastRun?: PersistedRun | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CreateOptions {
  id?: string;
  sessionId?: string;
  now?: number;
}

interface NormalizeOptions {
  now?: number;
  recoverStale?: boolean;
}

export function createConversation(options: CreateOptions = {}): PersistedConversation {
  const now = finiteTimestamp(options.now, Date.now());
  return {
    id: safeIdentifier(options.id) ?? randomId(),
    sessionId: safeIdentifier(options.sessionId) ?? randomId(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    messages: [],
    tools: [],
    lastRun: null,
  };
}

export function createEmptyChatHistory(options: CreateOptions = {}): PersistedChatHistory {
  void options;
  return { activeChatId: null, chats: [] };
}

export function createChat(history: PersistedChatHistory, options: CreateOptions = {}): PersistedChatHistory {
  const chat = createConversation(options);
  const adoptsPendingDraft = !getActiveChat(history) && Boolean(history.pendingDraft);
  if (adoptsPendingDraft) chat.draft = history.pendingDraft!;
  return compactHistory({
    ...history,
    ...(adoptsPendingDraft ? { pendingDraft: "" } : {}),
    activeChatId: chat.id,
    chats: [chat, ...history.chats.filter(hasConversationContent)],
  });
}

export function getActiveChat(history: PersistedChatHistory): PersistedConversation | null {
  return history.chats.find((chat) => chat.id === history.activeChatId)
    ?? null;
}

export function getComposerDraft(history: PersistedChatHistory): string {
  const active = getActiveChat(history);
  return active ? active.draft ?? "" : history.pendingDraft ?? "";
}

export function updateComposerDraft(history: PersistedChatHistory, value: string): PersistedChatHistory {
  const draft = value.slice(0, CHAT_HISTORY_LIMITS.fieldCharacters);
  return getActiveChat(history)
    ? updateActiveChat(history, { draft })
    : { ...history, pendingDraft: draft };
}

export function updateActiveChat(
  history: PersistedChatHistory,
  patch: PersistedConversationPatch,
  now = Date.now(),
): PersistedChatHistory {
  const active = getActiveChat(history) ?? createConversation({ now });
  const messages = patch.messages === undefined ? active.messages : [...patch.messages];
  const tools = patch.tools === undefined ? active.tools : [...patch.tools];
  const next: PersistedConversation = {
    ...active,
    ...(patch.draft === undefined ? {} : { draft: patch.draft.slice(0, CHAT_HISTORY_LIMITS.fieldCharacters) }),
    sessionId: safeIdentifier(patch.sessionId) ?? active.sessionId,
    title: patch.messages === undefined || active.titleIsCustom ? active.title : deriveChatTitle(messages),
    updatedAt: Math.max(active.createdAt, finiteTimestamp(now, active.updatedAt)),
    messages,
    tools,
    lastRun: patch.lastRun === undefined ? active.lastRun : patch.lastRun,
  };
  return compactHistory({
    ...history,
    activeChatId: active.id,
    chats: [next, ...history.chats.filter((chat) => chat.id !== active.id)],
  });
}

export function selectChat(history: PersistedChatHistory, chatId: string): PersistedChatHistory {
  if (!history.chats.some((chat) => chat.id === chatId)) return history;
  return chatId === history.activeChatId ? history : { ...history, activeChatId: chatId };
}

export function renameChat(history: PersistedChatHistory, chatId: string, value: string): PersistedChatHistory {
  const title = safeText(value, CHAT_HISTORY_LIMITS.titleCharacters);
  if (!title) return history;
  return { ...history, chats: history.chats.map((chat) => chat.id === chatId ? { ...chat, title, titleIsCustom: true } : chat) };
}

export function searchChats(history: PersistedChatHistory, query: string): PersistedConversation[] {
  const needle = query.trim().toLocaleLowerCase();
  return history.chats.filter((chat) => !needle || [chat.title, chat.draft ?? "", ...chat.messages.map((message) => message.content)]
    .some((text) => text.toLocaleLowerCase().includes(needle)));
}

export function deleteChat(
  history: PersistedChatHistory,
  chatId: string,
  options: CreateOptions = {},
): PersistedChatHistory {
  const remaining = history.chats.filter((chat) => chat.id !== chatId);
  if (!remaining.length) return { ...createEmptyChatHistory(options), ...(history.pendingDraft ? { pendingDraft: history.pendingDraft } : {}) };
  const activeChatId = chatId === history.activeChatId || !remaining.some((chat) => chat.id === history.activeChatId)
    ? newestFirst(remaining)[0]!.id
    : history.activeChatId;
  return compactHistory({ ...history, activeChatId, chats: remaining });
}

export function deriveChatTitle(messages: readonly PersistedMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  const source = firstUser ?? messages.find((message) => message.content.trim());
  if (!source) return "New chat";
  return truncate(source.content.replace(/\s+/g, " ").trim(), CHAT_HISTORY_LIMITS.titleCharacters);
}

export function normalizeChatHistory(value: unknown, options: NormalizeOptions = {}): PersistedChatHistory {
  const now = finiteTimestamp(options.now, Date.now());
  if (!isRecord(value) || !Array.isArray(value.chats)) return createEmptyChatHistory({ now });

  const chats: PersistedConversation[] = [];
  const chatIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const candidate of value.chats) {
    const chat = normalizeConversation(candidate, now, options.recoverStale === true);
    if (!chat) continue;
    if (chatIds.has(chat.id)) chat.id = randomId();
    if (sessionIds.has(chat.sessionId)) chat.sessionId = randomId();
    chatIds.add(chat.id);
    sessionIds.add(chat.sessionId);
    chats.push(chat);
  }

  const pendingDraft = typeof value.pendingDraft === "string" ? value.pendingDraft.slice(0, CHAT_HISTORY_LIMITS.fieldCharacters) : "";
  if (!chats.length) return { ...createEmptyChatHistory({ now }), ...(pendingDraft ? { pendingDraft } : {}) };
  const requestedActiveId = safeIdentifier(value.activeChatId);
  const activeChatId = value.activeChatId === null
    ? null
    : requestedActiveId && chats.some((chat) => chat.id === requestedActiveId)
      ? requestedActiveId
      : newestFirst(chats)[0]!.id;
  return compactHistory({ activeChatId, chats, ...(pendingDraft ? { pendingDraft } : {}) });
}

export function loadChatHistory(storage: StorageLike | null = browserStorage(), now = Date.now()): PersistedChatHistory {
  if (!storage) return createEmptyChatHistory({ now });
  try {
    const current = storage.getItem(CHAT_HISTORY_KEY);
    if (current) {
      try {
        const parsed: unknown = JSON.parse(current);
        if (isRecord(parsed) && parsed.version === HISTORY_VERSION) {
          return normalizeChatHistory(parsed, { now, recoverStale: true });
        }
      } catch {
        // A malformed current value should not prevent recovery from the legacy key.
      }
    }

    const legacy = storage.getItem(LEGACY_CHAT_KEY);
    if (legacy) {
      const migrated = migrateLegacyChat(JSON.parse(legacy), now);
      if (migrated) {
        try {
          storage.setItem(CHAT_HISTORY_KEY, JSON.stringify({ version: HISTORY_VERSION, ...migrated }));
          storage.removeItem(LEGACY_CHAT_KEY);
        } catch {
          // Returning the migrated history is still more useful than discarding it.
        }
        return migrated;
      }
    }
  } catch {
    // Invalid JSON or unavailable storage falls back to a fresh conversation.
  }
  return createEmptyChatHistory({ now });
}

export function projectChatHistoryKey(projectPath: string): string {
  const normalizedPath = projectPath.trim().replaceAll("\\", "/");
  return `${PROJECT_CHAT_HISTORY_KEY_PREFIX}:${encodeURIComponent(normalizedPath)}`;
}

export function loadProjectChatHistory(
  projectPath: string | null,
  storage: StorageLike | null = browserStorage(),
  now = Date.now(),
): PersistedChatHistory {
  if (!projectPath?.trim() || !storage) return createEmptyChatHistory({ now });
  try {
    const raw = storage.getItem(projectChatHistoryKey(projectPath));
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && parsed.version === HISTORY_VERSION) {
        return normalizeChatHistory(parsed, { now, recoverStale: true });
      }
    }

    const legacy = loadChatHistory(storage, now);
    if (legacy.chats.length) {
      const migrated = saveProjectChatHistory(projectPath, legacy, storage);
      clearChatHistory(storage);
      return migrated;
    }
  } catch {
    // Invalid or unavailable storage leaves the project with no open chat.
  }
  return createEmptyChatHistory({ now });
}

export function saveChatHistory(
  history: PersistedChatHistory,
  storage: StorageLike | null = browserStorage(),
): PersistedChatHistory {
  const normalized = normalizeChatHistory(history, { recoverStale: false });
  try {
    storage?.setItem(CHAT_HISTORY_KEY, JSON.stringify({ version: HISTORY_VERSION, ...normalized }));
  } catch {
    // Persistence is best-effort and must never prevent a conversation.
  }
  return normalized;
}

export function saveProjectChatHistory(
  projectPath: string | null,
  history: PersistedChatHistory,
  storage: StorageLike | null = browserStorage(),
): PersistedChatHistory {
  const normalized = normalizeChatHistory(history, { recoverStale: false });
  if (!projectPath?.trim()) return normalized;
  try {
    storage?.setItem(projectChatHistoryKey(projectPath), JSON.stringify({ version: HISTORY_VERSION, ...normalized }));
  } catch {
    // Persistence is best-effort and must never prevent a conversation.
  }
  return normalized;
}

export function clearChatHistory(storage: StorageLike | null = browserStorage()): void {
  try {
    storage?.removeItem(CHAT_HISTORY_KEY);
    storage?.removeItem(LEGACY_CHAT_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

export function loadFavoriteModels(storage: StorageLike | null = browserStorage()): string[] {
  try {
    const raw = storage?.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string").slice(0, 200)
      : [];
  } catch {
    return [];
  }
}

export function saveFavoriteModels(ids: readonly string[], storage: StorageLike | null = browserStorage()): void {
  try {
    storage?.setItem(FAVORITES_KEY, JSON.stringify(ids.slice(-200)));
  } catch {
    // Ignore unavailable storage.
  }
}

function normalizeConversation(value: unknown, now: number, recoverStale: boolean): PersistedConversation | null {
  if (!isRecord(value)) return null;
  const createdAt = finiteTimestamp(value.createdAt, now);
  const updatedAt = Math.max(createdAt, finiteTimestamp(value.updatedAt, createdAt));
  const normalizedMessages = normalizeMessages(value.messages);
  const messages = recoverStale
    ? normalizedMessages.filter((message) => message.role !== "assistant" || Boolean(message.content.trim()))
    : normalizedMessages;
  const tools = normalizeTools(value.tools, recoverStale);
  const storedTitle = safeText(value.title, CHAT_HISTORY_LIMITS.titleCharacters);
  return {
    id: safeIdentifier(value.id) ?? randomId(),
    sessionId: safeIdentifier(value.sessionId) ?? randomId(),
    title: storedTitle || deriveChatTitle(messages),
    ...(value.titleIsCustom === true ? { titleIsCustom: true } : {}),
    ...(typeof value.draft === "string" && value.draft ? { draft: value.draft.slice(0, CHAT_HISTORY_LIMITS.fieldCharacters) } : {}),
    createdAt,
    updatedAt,
    messages,
    tools,
    lastRun: normalizeRun(value.lastRun),
  };
}

function normalizeMessages(value: unknown): PersistedMessage[] {
  if (!Array.isArray(value)) return [];
  const normalized: PersistedMessage[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !isMessageRole(candidate.role) || typeof candidate.content !== "string") continue;
    let id = safeIdentifier(candidate.id) ?? randomId();
    if (ids.has(id)) id = randomId();
    ids.add(id);
    normalized.push({ id, role: candidate.role, content: truncate(candidate.content, CHAT_HISTORY_LIMITS.fieldCharacters) });
  }
  return keepNewestWithinBudget(
    normalized,
    CHAT_HISTORY_LIMITS.messagesPerChat,
    (message) => message.content.length,
    300_000,
  );
}

function normalizeTools(value: unknown, recoverStale: boolean): PersistedTool[] {
  if (!Array.isArray(value)) return [];
  const normalized: PersistedTool[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const name = safeText(candidate.name, 500);
    const status = isToolStatus(candidate.status) ? candidate.status : null;
    if (!name || !status) continue;
    let id = safeIdentifier(candidate.id) ?? randomId();
    if (ids.has(id)) id = randomId();
    ids.add(id);
    const stale = recoverStale && (status === "running" || status === "approval");
    const summary = stale
      ? INTERRUPTED_SUMMARY
      : safeOptionalText(candidate.summary, CHAT_HISTORY_LIMITS.fieldCharacters);
    const tool: PersistedTool = {
      id,
      name,
      status: stale ? "failed" : status,
      ...(summary ? { summary } : {}),
      ...(!stale && safeIdentifier(candidate.approvalId) ? { approvalId: safeIdentifier(candidate.approvalId)! } : {}),
      ...(safeOptionalText(candidate.error, CHAT_HISTORY_LIMITS.fieldCharacters) ? { error: safeOptionalText(candidate.error, CHAT_HISTORY_LIMITS.fieldCharacters)! } : {}),
      ...(safeOptionalText(candidate.preview, CHAT_HISTORY_LIMITS.fieldCharacters) ? { preview: safeOptionalText(candidate.preview, CHAT_HISTORY_LIMITS.fieldCharacters)! } : {}),
      ...(safeOptionalText(candidate.path, 5_000) ? { path: safeOptionalText(candidate.path, 5_000)! } : {}),
      ...(finiteOptionalTimestamp(candidate.startedAt) === undefined ? {} : { startedAt: finiteOptionalTimestamp(candidate.startedAt)! }),
      ...(finiteOptionalTimestamp(candidate.finishedAt) === undefined ? {} : { finishedAt: finiteOptionalTimestamp(candidate.finishedAt)! }),
      ...(jsonValue(candidate.arguments, 100_000) === undefined ? {} : { arguments: jsonValue(candidate.arguments, 100_000) as Record<string, unknown> }),
      ...(jsonValue(candidate.result, 100_000) === undefined ? {} : { result: jsonValue(candidate.result, 100_000) }),
    };
    normalized.push(tool);
  }
  return keepNewestWithinBudget(
    normalized,
    CHAT_HISTORY_LIMITS.toolsPerChat,
    (tool) => jsonLength(tool),
    100_000,
  );
}

function normalizeRun(value: unknown): PersistedRun | null {
  if (!isRecord(value) || !isRecord(value.request)) return null;
  const assistantId = safeIdentifier(value.assistantId);
  if (!assistantId || jsonLength(value) > 40_000) return null;
  return {
    request: value.request as unknown as AgentRunRequest,
    assistantId,
    at: finiteTimestamp(value.at, Date.now()),
  };
}

function migrateLegacyChat(value: unknown, now: number): PersistedChatHistory | null {
  if (!isRecord(value) || (!Array.isArray(value.messages) && !Array.isArray(value.tools))) return null;
  const chat = normalizeConversation({
    id: randomId(),
    sessionId: value.sessionId,
    title: "",
    createdAt: now,
    updatedAt: now,
    messages: value.messages,
    tools: value.tools,
    lastRun: value.lastRun,
  }, now, true);
  if (!chat) return null;
  chat.title = deriveChatTitle(chat.messages);
  return { activeChatId: chat.id, chats: [chat] };
}

function compactHistory(history: PersistedChatHistory): PersistedChatHistory {
  const active = history.activeChatId === null
    ? null
    : history.chats.find((chat) => chat.id === history.activeChatId) ?? null;
  const candidates = active
    ? [active, ...newestFirst(history.chats).filter((chat) => chat.id !== active.id && hasConversationContent(chat))]
    : newestFirst(history.chats).filter(hasConversationContent);
  const kept: PersistedConversation[] = [];
  let totalCharacters = 0;
  for (const chat of candidates) {
    if (kept.length >= CHAT_HISTORY_LIMITS.chats) break;
    const characters = Math.min(jsonLength(chat), CHAT_HISTORY_LIMITS.chatCharacters);
    if (chat.id !== active?.id && totalCharacters + characters > CHAT_HISTORY_LIMITS.totalCharacters) continue;
    kept.push(chat);
    totalCharacters += characters;
  }
  return { activeChatId: active?.id ?? null, chats: newestFirst(kept), ...(history.pendingDraft ? { pendingDraft: history.pendingDraft.slice(0, CHAT_HISTORY_LIMITS.fieldCharacters) } : {}) };
}

function keepNewestWithinBudget<T>(
  items: readonly T[],
  limit: number,
  size: (item: T) => number,
  characterBudget: number,
): T[] {
  const kept: T[] = [];
  let characters = 0;
  for (let index = items.length - 1; index >= 0 && kept.length < limit; index -= 1) {
    const item = items[index];
    if (item === undefined) continue;
    const itemSize = Math.max(0, size(item));
    if (kept.length && characters + itemSize > characterBudget) break;
    kept.push(item);
    characters += itemSize;
  }
  return kept.reverse();
}

function newestFirst(chats: readonly PersistedConversation[]): PersistedConversation[] {
  return [...chats].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
}

function hasConversationContent(chat: PersistedConversation): boolean {
  return chat.messages.length > 0 || chat.tools.length > 0 || Boolean(chat.draft) || chat.titleIsCustom === true;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMessageRole(value: unknown): value is PersistedMessage["role"] {
  return value === "user" || value === "assistant";
}

function isToolStatus(value: unknown): value is PersistedTool["status"] {
  return value === "running" || value === "approval" || value === "done" || value === "failed";
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 200 ? trimmed : null;
}

function safeText(value: unknown, limit: number): string {
  return typeof value === "string" ? truncate(value.replace(/\s+/g, " ").trim(), limit) : "";
}

function safeOptionalText(value: unknown, limit: number): string | undefined {
  const text = safeText(value, limit);
  return text || undefined;
}

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finiteOptionalTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return CHAT_HISTORY_LIMITS.chatCharacters + 1;
  }
}

function jsonValue(value: unknown, limit: number): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length > limit) return undefined;
    return JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }
}
