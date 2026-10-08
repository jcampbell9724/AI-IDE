import {
  attachDebugger,
  debuggerStatus,
  detachDebugger,
  sendStableCdpCommand,
} from "./debuggerAdapter";

interface BrowserRequestMessage {
  type: "browser.request";
  request: {
    id: string;
    command: string;
    params?: Record<string, unknown>;
  };
}

const CONTENT_COMMANDS = new Set([
  "picker.start",
  "picker.stop",
  "picker.clear",
  "context.capture",
  "selection.remove",
  "edit.apply",
  "edit.undo",
  "edit.redo",
  "edit.discard",
  "edit.deltas",
  "interaction.click",
  "interaction.type",
  "interaction.key",
  "interaction.scroll",
  "interaction.hover",
  "interaction.focus",
  "interaction.wait_for",
]);

const contentInjections = new Map<number, Promise<void>>();

export function isBrowserRequest(message: unknown): message is BrowserRequestMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<BrowserRequestMessage>;
  return candidate.type === "browser.request" && !!candidate.request && typeof candidate.request.command === "string";
}

export async function brokerBrowserRequest(message: BrowserRequestMessage): Promise<unknown> {
  const { command, params = {} } = message.request;
  const tab = await targetTab(params);

  switch (command) {
    case "tabs.getActive":
    case "getActiveTab":
      return sanitizeTab(tab);
    case "tabs.list": {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return tabs.map(sanitizeTab);
    }
    case "tabs.navigate":
    case "navigate": {
      const url = requiredString(params, "url");
      assertNavigableUrl(url);
      if (tab.id === undefined) throw new Error("The active tab has no id.");
      const updated = await chrome.tabs.update(tab.id, { url });
      if (!updated) throw new Error("Chrome did not return the navigated tab.");
      return sanitizeTab(updated);
    }
    case "tabs.reload":
    case "reload":
      await requireTabId(tab).then((tabId) => chrome.tabs.reload(tabId));
      return { reloaded: true, discardPreview: true };
    case "tabs.back":
    case "back":
      await requireTabId(tab).then((tabId) => chrome.tabs.goBack(tabId));
      return { navigated: "back" };
    case "tabs.forward":
    case "forward":
      await requireTabId(tab).then((tabId) => chrome.tabs.goForward(tabId));
      return { navigated: "forward" };
    case "tabs.screenshot":
    case "screenshot": {
      const tabId = await requireTabId(tab);
      let targetChanged = false;
      const onActivated = (info: chrome.tabs.TabActiveInfo): void => {
        if (info.windowId === tab.windowId && info.tabId !== tabId) targetChanged = true;
      };
      const onUpdated = (id: number, change: chrome.tabs.TabChangeInfo): void => {
        if (id === tabId && change.url !== undefined && change.url !== tab.url) targetChanged = true;
      };
      chrome.tabs.onActivated.addListener(onActivated);
      chrome.tabs.onUpdated.addListener(onUpdated);
      try {
        const active = await activeTab();
        if (active.id !== tabId) throw new Error("Activate the requested tab before taking its screenshot.");
        assertSamePage(tab, active);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
        const [current, activeAfter] = await Promise.all([chrome.tabs.get(tabId), activeTab()]);
        assertSamePage(tab, current);
        assertSamePage(tab, activeAfter);
        if (targetChanged) throw new Error("The active tab changed during screenshot capture. Try again.");
        return { dataUrl, tab: sanitizeTab(current) };
      } finally {
        chrome.tabs.onActivated.removeListener(onActivated);
        chrome.tabs.onUpdated.removeListener(onUpdated);
      }
    }
    case "page.context": {
      const tabId = await requireTabId(tab);
      const elements = await sendContentCommand(tabId, "context.capture", params);
      const current = await chrome.tabs.get(tabId);
      assertSamePage(tab, current);
      return { tab: sanitizeTab(current), elements };
    }
    case "cdp.attach":
      return attachDebugger(await requireTabId(tab));
    case "cdp.detach":
      return detachDebugger(await requireTabId(tab));
    case "cdp.status":
      return debuggerStatus(await requireTabId(tab));
    case "cdp.command": {
      const method = requiredString(params, "method");
      const commandParams = isRecord(params.params) ? params.params : {};
      return sendStableCdpCommand(await requireTabId(tab), method, commandParams);
    }
    default:
      if (command.startsWith("content.")) {
        const contentCommand = command.slice("content.".length);
        if (!CONTENT_COMMANDS.has(contentCommand)) throw new Error("Content command is not allowlisted: " + contentCommand);
        return sendContentCommand(await requireTabId(tab), contentCommand, params);
      }
      throw new Error("Browser command is not allowlisted: " + command);
  }
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab is available.");
  return tab;
}

async function targetTab(params: Record<string, unknown>): Promise<chrome.tabs.Tab> {
  const requestedId = params.tabId;
  if (requestedId === undefined) return activeTab();
  if (!Number.isInteger(requestedId) || Number(requestedId) < 0) {
    throw new Error("tabId must be a non-negative integer.");
  }
  const [current, requested] = await Promise.all([
    activeTab(),
    chrome.tabs.get(Number(requestedId)),
  ]);
  if (requested.windowId !== current.windowId) {
    throw new Error("The requested browser tab is not in the current window.");
  }
  return requested;
}

async function requireTabId(tab: chrome.tabs.Tab): Promise<number> {
  if (tab.id === undefined) throw new Error("The active tab has no id.");
  return tab.id;
}

async function sendContentCommand(tabId: number, command: string, params: Record<string, unknown>): Promise<unknown> {
  const tab = await chrome.tabs.get(tabId);
  if (!isLocalDevelopmentUrl(tab.url)) {
    throw new Error("Page inspection and visual editing are restricted to localhost development pages.");
  }
  let response: unknown;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: "content.command", command, params });
  } catch {
    assertSamePage(tab, await chrome.tabs.get(tabId));
    await ensureContentScript(tabId);
    assertSamePage(tab, await chrome.tabs.get(tabId));
    try {
      response = await chrome.tabs.sendMessage(tabId, { type: "content.command", command, params });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error("The page helper is unavailable on this tab. " + detail);
    }
  }
  if (isRecord(response) && typeof response.error === "string" && response.error.trim()) {
    throw new Error(response.error.trim());
  }
  return response;
}

function assertSamePage(expected: chrome.tabs.Tab, current: chrome.tabs.Tab): void {
  if (expected.id !== current.id || expected.url !== current.url) {
    throw new Error("The browser page changed before the command could finish. Capture context again.");
  }
}

function ensureContentScript(tabId: number): Promise<void> {
  const existing = contentInjections.get(tabId);
  if (existing) return existing;
  const injection = chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })
    .then(() => undefined)
    .finally(() => contentInjections.delete(tabId));
  contentInjections.set(tabId, injection);
  return injection;
}

function sanitizeTab(tab: chrome.tabs.Tab): Record<string, unknown> {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
    status: tab.status,
  };
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing string parameter: " + key);
  return value;
}

function assertNavigableUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS navigation is allowed.");
  }
}

function isLocalDevelopmentUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
