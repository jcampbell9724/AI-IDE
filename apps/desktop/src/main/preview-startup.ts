import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import type { PreviewStartupState } from "../shared/contracts";
import { loopbackUrl } from "./browser-url";

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

// Probe only the configured local server. Redirects are left to the browser's
// navigation policy; the readiness check must never follow them itself.
export async function probePreview(value: string, signal: AbortSignal): Promise<boolean> {
  const url = loopbackUrl(value);
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    const request = (url.protocol === "https:" ? httpsGet : httpGet)(url, { signal }, (response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      resolve(status >= 200 && status < 500);
    });
    const timer = setTimeout(() => request.destroy(new Error("Preview probe timed out")), 2000);
    request.once("close", () => clearTimeout(timer));
    request.once("error", () => resolve(false));
  });
}

export class PreviewStartup {
  state: PreviewStartupState = { phase: "idle" };
  private controller: AbortController | undefined;

  constructor(
    private readonly changed: () => void,
    private readonly probe = probePreview,
    private readonly timeoutMs = 60_000,
    private readonly intervalMs = 500,
  ) {}

  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.update({ phase: "idle" });
  }

  async start(
    url: string | null,
    launch: () => Promise<unknown>,
    isRunning: () => boolean,
    navigate: (url: string, signal: AbortSignal) => Promise<unknown>,
    findUrl?: () => string | null,
  ): Promise<void> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    this.update({ phase: "starting" });
    try {
      const target = url ? loopbackUrl(url).toString() : null;
      await launch();
      if (controller.signal.aborted) return;
      if (!target && !findUrl) {
        this.update({ phase: "needs-url" });
        return;
      }
      this.update({ phase: "waiting", ...(target ? { url: target } : {}) });
      // Starting the process does not hold the IPC call open during readiness
      // checks, so the user can still stop or restart it.
      void this.wait(target, controller.signal, isRunning, navigate, findUrl);
    } catch (error) {
      if (!controller.signal.aborted) this.update({ phase: "failed", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async wait(preferredUrl: string | null, signal: AbortSignal, isRunning: () => boolean, navigate: (url: string, signal: AbortSignal) => Promise<unknown>, findUrl?: () => string | null): Promise<void> {
    let url = preferredUrl;
    const deadline = Date.now() + this.timeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const boundedSignal = AbortSignal.any([signal, timeout.signal]);
    const timeoutMessage = "The preview did not respond within 60 seconds. Check the URL and run command, then open the preview or restart the project.";
    try {
      while (!signal.aborted) {
        if (!isRunning()) throw new Error("The project stopped before its preview was ready. Check the run command, then start it again.");
        if (boundedSignal.aborted || Date.now() >= deadline) {
          if (!url) { this.update({ phase: "needs-url" }); return; }
          throw new Error(timeoutMessage);
        }
        // Keep a working saved address, but refresh discovery on every failed
        // attempt: development servers can move to a different available port.
        let readyUrl = preferredUrl && await this.probe(preferredUrl, boundedSignal) ? preferredUrl : null;
        if (signal.aborted) return;
        if (boundedSignal.aborted) throw new Error(timeoutMessage);
        if (!readyUrl && findUrl) {
          const discovered = findUrl();
          if (signal.aborted) return;
          if (discovered) {
            url = loopbackUrl(discovered).toString();
            if (this.state.url !== url) this.update({ phase: "waiting", url });
          }
          if (url && url !== preferredUrl && await this.probe(url, boundedSignal)) readyUrl = url;
        }
        if (readyUrl) {
          if (signal.aborted) return;
          if (boundedSignal.aborted) throw new Error(timeoutMessage);
          if (!isRunning()) continue;
          await navigate(readyUrl, boundedSignal);
          if (signal.aborted) return;
          if (boundedSignal.aborted) throw new Error(timeoutMessage);
          if (!isRunning()) throw new Error("The project stopped while its preview was loading. Start it again to retry.");
          this.update({ phase: "ready", url: readyUrl });
          return;
        }
        await pause(this.intervalMs, boundedSignal);
      }
    } catch (error) {
      if (!signal.aborted) this.update({ phase: "failed", ...(url ? { url } : {}), message: timeout.signal.aborted ? timeoutMessage : error instanceof Error ? error.message : String(error) });
    } finally { clearTimeout(timer); }
  }

  private update(state: PreviewStartupState): void {
    this.state = state;
    this.changed();
  }
}
