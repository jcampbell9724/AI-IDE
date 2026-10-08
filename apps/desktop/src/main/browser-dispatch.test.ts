import type { BrowserRequest } from "@browser-agent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserBridge } from "../../../daemon/src/browser-bridge";
import { dispatchBrowserRequest } from "./browser-dispatch";

type Execute = Parameters<typeof dispatchBrowserRequest>[2]["execute"];

function enqueue(bridge: BrowserBridge, options: { runId?: string; signal?: AbortSignal } = {}) {
  let request: BrowserRequest | undefined;
  const pending = bridge.request({
    runId: options.runId ?? "browser-run",
    action: "wait_for",
    arguments: { selector: "#ready" },
    ...options,
    emit: (event) => { if (event.type === "browser.request") request = event.request; },
  });
  // Observe rejection immediately, including cancellation before dispatch.
  const outcome = pending.then((result) => ({ result }), (error: unknown) => ({ error }));
  if (!request) throw new Error("Expected the bridge to emit a browser request.");
  return { request, outcome };
}

function abortableDriver() {
  const aborted = vi.fn();
  const execute = vi.fn<Execute>((_action, _arguments, signal) => new Promise((_resolve, reject) => {
    if (!signal) throw new Error("Expected a browser execution signal.");
    signal.addEventListener("abort", () => { aborted(signal.reason); reject(signal.reason); }, { once: true });
  }));
  return { execute, aborted };
}

afterEach(() => { vi.useRealTimers(); });

describe("desktop browser request dispatch", () => {
  it("passes the bridge signal and correlates a successful driver result", async () => {
    const bridge = new BrowserBridge();
    const { request, outcome } = enqueue(bridge);
    const signal = bridge.signalForRequest(request.id);
    const result = { found: true };
    const browser = { execute: vi.fn<Execute>().mockResolvedValue(result) };

    await dispatchBrowserRequest(request, bridge, browser);

    expect(browser.execute).toHaveBeenCalledExactlyOnceWith(request.action, request.arguments, signal);
    expect(signal?.aborted).toBe(false);
    await expect(outcome).resolves.toEqual({ result });
    expect(bridge.signalForRequest(request.id)).toBeUndefined();
    expect(bridge.resolve(request.id, { result: "duplicate" })).toBe(false);
  });

  it("routes a driver failure only to its request while another request succeeds", async () => {
    const bridge = new BrowserBridge();
    const failed = enqueue(bridge, { runId: "failed-run" });
    const successful = enqueue(bridge, { runId: "successful-run" });
    const successfulSignal = bridge.signalForRequest(successful.request.id);
    const browser = { execute: vi.fn<Execute>().mockRejectedValueOnce(new Error("Element not found")).mockResolvedValueOnce({ ready: true }) };

    await dispatchBrowserRequest(failed.request, bridge, browser);

    await expect(failed.outcome).resolves.toMatchObject({ error: { code: "BROWSER_FAILED", message: "Element not found", status: 502 } });
    expect(bridge.signalForRequest(successful.request.id)).toBe(successfulSignal);
    expect(successfulSignal?.aborted).toBe(false);

    await dispatchBrowserRequest(successful.request, bridge, browser);

    await expect(successful.outcome).resolves.toEqual({ result: { ready: true } });
  });

  it.each(["input signal", "cancelRun"] as const)("aborts the active driver through %s", async (cancellation) => {
    const bridge = new BrowserBridge();
    const controller = new AbortController();
    const { request, outcome } = enqueue(bridge, { signal: controller.signal });
    const browser = abortableDriver();
    const dispatch = dispatchBrowserRequest(request, bridge, browser);
    const signal = browser.execute.mock.calls[0]?.[2];

    if (cancellation === "input signal") controller.abort();
    else bridge.cancelRun(request.runId);
    await dispatch;

    expect(signal?.aborted).toBe(true);
    expect(browser.aborted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "AbortError" }));
    await expect(outcome).resolves.toMatchObject({ error: { name: "AbortError" } });
    expect(bridge.signalForRequest(request.id)).toBeUndefined();
  });

  it("aborts the active driver when the bridge request times out", async () => {
    vi.useFakeTimers();
    const bridge = new BrowserBridge(50);
    const { request, outcome } = enqueue(bridge);
    const browser = abortableDriver();
    const dispatch = dispatchBrowserRequest(request, bridge, browser);

    await vi.advanceTimersByTimeAsync(50);
    await dispatch;

    expect(browser.execute.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(browser.aborted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "BROWSER_TIMEOUT" }));
    await expect(outcome).resolves.toMatchObject({ error: { code: "BROWSER_TIMEOUT", status: 408 } });
    expect(bridge.signalForRequest(request.id)).toBeUndefined();
  });

  it.each(["cancelled", "expired"] as const)("does not execute a request delivered after it was %s", async (state) => {
    vi.useFakeTimers();
    const bridge = new BrowserBridge(50);
    const { request, outcome } = enqueue(bridge);
    const browser = { execute: vi.fn<Execute>().mockResolvedValue({ late: true }) };
    if (state === "cancelled") bridge.cancelRun(request.runId);
    else await vi.advanceTimersByTimeAsync(50);

    await dispatchBrowserRequest(request, bridge, browser);

    expect(browser.execute).not.toHaveBeenCalled();
    await expect(outcome).resolves.toMatchObject({ error: state === "cancelled" ? { name: "AbortError" } : { code: "BROWSER_TIMEOUT" } });
  });

  it("does not report a late driver success after its request was cancelled", async () => {
    const bridge = new BrowserBridge();
    const { request, outcome } = enqueue(bridge);
    let finishDriver!: (result: unknown) => void;
    const browser = { execute: vi.fn<Execute>(() => new Promise((resolve) => { finishDriver = resolve; })) };
    const resolveRequest = vi.spyOn(bridge, "resolve");
    const dispatch = dispatchBrowserRequest(request, bridge, browser);

    bridge.cancelRun(request.runId);
    await expect(outcome).resolves.toMatchObject({ error: { name: "AbortError" } });
    finishDriver({ clicked: true });
    await dispatch;

    expect(resolveRequest).toHaveBeenCalledExactlyOnceWith(request.id, { error: "Operation cancelled" });
    expect(resolveRequest).toHaveReturnedWith(false);
    expect(bridge.signalForRequest(request.id)).toBeUndefined();
    await expect(outcome).resolves.toMatchObject({ error: { name: "AbortError" } });
  });
});
