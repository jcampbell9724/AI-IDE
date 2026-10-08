import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  BrowserAction,
  BrowserResultInput,
} from "@browser-agent/shared";
import { AppError, throwIfAborted } from "./errors.js";

interface PendingBrowserRequest {
  readonly runId: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timeout: NodeJS.Timeout;
  readonly controller: AbortController;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

export class BrowserBridge {
  private readonly pending = new Map<string, PendingBrowserRequest>();

  constructor(private readonly requestTimeoutMs = 60_000) {}

  async request(input: {
    runId: string;
    action: BrowserAction;
    arguments: Record<string, unknown>;
    emit: (event: AgentEvent) => void;
    signal?: AbortSignal;
  }): Promise<unknown> {
    throwIfAborted(input.signal);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const controller = new AbortController();
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(id, new AppError("BROWSER_TIMEOUT", "Browser request timed out", 408));
      }, this.requestTimeoutMs);
      timeout.unref();
      const onAbort = input.signal
        ? () => {
            this.fail(id, new DOMException("Operation cancelled", "AbortError"));
          }
        : undefined;
      if (onAbort) input.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        runId: input.runId,
        resolve,
        reject,
        timeout,
        controller,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(onAbort === undefined ? {} : { onAbort }),
      });
      if (input.signal?.aborted) onAbort?.();
    });

    if (!input.signal?.aborted) {
      try {
        input.emit({
          type: "browser.request",
          runId: input.runId,
          timestamp: createdAt,
          request: {
            id,
            runId: input.runId,
            action: input.action,
            arguments: input.arguments,
            createdAt,
          },
        });
      } catch (error) {
        this.fail(id, error);
      }
    }
    return result;
  }

  signalForRequest(id: string): AbortSignal | undefined {
    return this.pending.get(id)?.controller.signal;
  }

  resolve(id: string, input: BrowserResultInput): boolean {
    const pending = this.take(id);
    if (!pending) return false;
    if (input.error !== undefined) pending.reject(new AppError("BROWSER_FAILED", input.error, 502));
    else pending.resolve(input.result);
    return true;
  }

  cancelRun(runId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.runId !== runId) continue;
      this.fail(id, new DOMException("Operation cancelled", "AbortError"));
    }
  }

  private fail(id: string, error: unknown): void {
    const pending = this.take(id);
    if (!pending) return;
    // Remove the request before aborting its driver: an abort listener may
    // synchronously try to report the interrupted browser operation's result.
    pending.reject(error);
    pending.controller.abort(error);
  }

  private take(id: string): PendingBrowserRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
    return pending;
  }
}
