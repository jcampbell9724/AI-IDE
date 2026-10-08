const STABLE_CDP_COMMANDS = new Set([
  "Page.enable",
  "Runtime.enable",
  "DOM.enable",
  "CSS.enable",
  "Page.getLayoutMetrics",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.getBoxModel",
  "Page.captureScreenshot",
]);

const attachedTabs = new Set<number>();

function target(tabId: number): chrome.debugger.Debuggee {
  return { tabId };
}

export async function attachDebugger(tabId: number): Promise<{ attached: true; tabId: number }> {
  if (!(await isDebuggerAttached(tabId))) {
    await chrome.debugger.attach(target(tabId), "1.3");
  }
  attachedTabs.add(tabId);
  return { attached: true, tabId };
}

export async function detachDebugger(tabId: number): Promise<{ attached: false; tabId: number }> {
  if (await isDebuggerAttached(tabId)) {
    await chrome.debugger.detach(target(tabId));
  }
  attachedTabs.delete(tabId);
  return { attached: false, tabId };
}

export async function debuggerStatus(tabId: number): Promise<{ attached: boolean; tabId: number }> {
  return { attached: await isDebuggerAttached(tabId), tabId };
}

export async function sendStableCdpCommand(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  if (!STABLE_CDP_COMMANDS.has(method)) throw new Error("CDP command is not allowlisted: " + method);
  if (!(await isDebuggerAttached(tabId))) throw new Error("The debugger adapter is not attached to the active tab.");
  return chrome.debugger.sendCommand(target(tabId), method, params);
}

export async function cleanupDebugger(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) return;
  await detachDebugger(tabId).catch(() => undefined);
}

export function registerDebuggerListeners(): void {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) attachedTabs.delete(source.tabId);
  });
}

async function isDebuggerAttached(tabId: number): Promise<boolean> {
  if (attachedTabs.has(tabId)) return true;
  const targets = await chrome.debugger.getTargets();
  const attached = targets.some((item) => item.tabId === tabId && item.attached);
  if (attached) attachedTabs.add(tabId);
  return attached;
}
