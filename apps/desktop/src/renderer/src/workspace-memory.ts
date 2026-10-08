import type { StorageLike } from "./persist";

export interface WorkspaceView {
  files: string[];
  activeFile: string | null;
  sidebar: "chats" | "files" | "projects" | "models";
  sidebarOpen: boolean;
  chatScroll: Record<string, number>;
  fileScroll: Record<string, number>;
}

export function emptyWorkspaceView(): WorkspaceView {
  return { files: [], activeFile: null, sidebar: "chats", sidebarOpen: false, chatScroll: {}, fileScroll: {} };
}

function storage(): StorageLike | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

function key(project: string): string {
  return `browser-agent.desktop.workspace.v1:${encodeURIComponent(project.replaceAll("\\", "/"))}`;
}

function isRelativePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 4096
    && !path.startsWith("/") && !path.includes("\\") && !path.includes(":")
    && !path.split("/").some((part) => part === ".." || part === "." || part === "");
}

function scrollPositions(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, position]) =>
    id.length <= 4096 && typeof position === "number" && Number.isFinite(position) && position >= 0 && position <= 100_000_000,
  ).slice(-50));
}

export function normalizeWorkspaceView(value: unknown): WorkspaceView {
  const empty = emptyWorkspaceView();
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const data = value as Record<string, unknown>;
  const files = Array.isArray(data.files) ? [...new Set(data.files.filter(isRelativePath))].slice(0, 20) : [];
  return {
    files,
    activeFile: typeof data.activeFile === "string" && files.includes(data.activeFile) ? data.activeFile : null,
    sidebar: ["chats", "files", "projects", "models"].includes(String(data.sidebar)) ? data.sidebar as WorkspaceView["sidebar"] : "chats",
    sidebarOpen: data.sidebarOpen === true,
    chatScroll: scrollPositions(data.chatScroll),
    fileScroll: scrollPositions(data.fileScroll),
  };
}

export function loadWorkspaceView(project: string, store = storage()): WorkspaceView {
  try { return normalizeWorkspaceView(JSON.parse(store?.getItem(key(project)) ?? "null")); }
  catch { return emptyWorkspaceView(); }
}

export function saveWorkspaceView(project: string | null, view: WorkspaceView, store = storage()): void {
  if (!project) return;
  try { store?.setItem(key(project), JSON.stringify(normalizeWorkspaceView(view))); }
  catch { /* Workspace navigation remains usable when storage is unavailable. */ }
}
