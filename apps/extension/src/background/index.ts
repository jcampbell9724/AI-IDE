import { brokerBrowserRequest, isBrowserRequest } from "./broker";
import { cleanupDebugger, registerDebuggerListeners } from "./debuggerAdapter";
import { restrictLocalStorageToTrustedContexts } from "../lib/settings";

void initializeSecurityBoundary();

chrome.runtime.onInstalled.addListener(() => {
  void initializeSecurityBoundary();
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void initializeSecurityBoundary();
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  const enabled = !!tab.url && /^https?:\/\//.test(tab.url);
  void chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void cleanupDebugger(tabId);
});

registerDebuggerListeners();

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, error: detail });
    });
  return true;
});

async function handleMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (sender.id !== chrome.runtime.id) throw new Error("Rejected a message from an untrusted extension context.");
  if (isBrowserRequest(message)) return brokerBrowserRequest(message);

  if (isContentEvent(message)) {
    if (!sender.tab?.url || !isLocalDevelopmentUrl(sender.tab.url)) {
      throw new Error("Rejected a content event outside a local development page.");
    }
    return { received: true };
  }

  throw new Error("Unsupported extension message.");
}

function isContentEvent(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { type?: unknown; event?: unknown };
  if (candidate.type !== "content.event" || !candidate.event || typeof candidate.event !== "object") return false;
  const eventType = (candidate.event as { type?: unknown }).type;
  return typeof eventType === "string" && [
    "selection.added",
    "selection.removed",
    "selection.cleared",
    "picker.stopped",
    "preview.changed",
  ].includes(eventType);
}

function isLocalDevelopmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

async function initializeSecurityBoundary(): Promise<void> {
  await restrictLocalStorageToTrustedContexts();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}
