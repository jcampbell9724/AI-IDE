import type { ExtensionSettings } from "./types";

const SETTINGS_KEY = "browserAgent.settings";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  daemonUrl: "http://127.0.0.1:3210",
  token: "",
  approvalMode: "ask",
  selectedModel: "",
  favoriteModels: [],
  cdpEnabled: false,
};

export function normalizeDaemonUrl(value: string): string {
  const url = new URL(value.trim());
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !isLoopback || url.username || url.password) {
    throw new Error("Daemon URL must use HTTP on localhost or a loopback address.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const candidate = stored[SETTINGS_KEY];
  if (!candidate || typeof candidate !== "object") return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(candidate as Partial<ExtensionSettings>) };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  const normalized: ExtensionSettings = {
    ...settings,
    daemonUrl: normalizeDaemonUrl(settings.daemonUrl),
    favoriteModels: [...new Set(settings.favoriteModels)],
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
}

export async function restrictLocalStorageToTrustedContexts(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}
