import type { BrowserRequest } from "@browser-agent/shared";
import type { DaemonRuntime } from "@browser-agent/daemon";
import type { DesktopBrowser } from "./desktop-browser";

export async function dispatchBrowserRequest(
  request: BrowserRequest,
  bridge: Pick<DaemonRuntime["browser"], "signalForRequest" | "resolve">,
  browser: Pick<DesktopBrowser, "execute">,
): Promise<void> {
  const signal = bridge.signalForRequest(request.id);
  // The run may have ended before its request was delivered to the browser.
  if (!signal || signal.aborted) return;
  try {
    const result = await browser.execute(request.action, request.arguments, signal);
    signal.throwIfAborted();
    bridge.resolve(request.id, { result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bridge.resolve(request.id, { error: message });
  }
}
