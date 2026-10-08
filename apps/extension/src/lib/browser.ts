import type { BrowserRequest } from "./types";

export interface BrokerResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export async function brokerRequest<T = unknown>(command: string, params?: Record<string, unknown>): Promise<T> {
  const response = (await chrome.runtime.sendMessage({
    type: "browser.request",
    request: { id: crypto.randomUUID(), command, params },
  })) as BrokerResponse<T> | undefined;
  if (!response?.ok) throw new Error(response?.error ?? "Browser request failed.");
  return response.data as T;
}

export async function executeDaemonBrowserRequest(request: BrowserRequest): Promise<unknown> {
  if (request.command) return brokerRequest(request.command, request.params);
  const args = request.arguments ?? {};
  switch (request.action) {
    case "context":
      return brokerRequest("page.context", args);
    case "inspect_element":
      return brokerRequest("content.context.capture", args);
    case "navigate":
      return brokerRequest("tabs.navigate", args);
    case "back":
      return brokerRequest("tabs.back", args);
    case "forward":
      return brokerRequest("tabs.forward", args);
    case "refresh":
      return brokerRequest("tabs.reload", args);
    case "tabs":
      return brokerRequest("tabs.list");
    case "screenshot":
      return brokerRequest("tabs.screenshot", args);
    case "click":
    case "type":
    case "key":
    case "scroll":
    case "hover":
    case "focus":
    case "wait_for":
      return brokerRequest("content.interaction." + request.action, args);
    case "console":
    case "network_errors":
      throw new Error("Browser action is intentionally unsupported by this extension adapter: " + request.action);
    default:
      throw new Error("Unknown daemon browser action: " + String(request.action));
  }
}

export function sendContentCommand<T = unknown>(command: string, params?: Record<string, unknown>): Promise<T> {
  return brokerRequest<T>("content." + command, params);
}
