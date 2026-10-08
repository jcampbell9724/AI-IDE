import type { AgentEvent } from "@browser-agent/shared";
import { describe, expect, it, vi } from "vitest";
import { BrowserBridge } from "./browser-bridge.js";

describe("BrowserBridge", () => {
  it("correlates a browser result and ignores a duplicate result", async () => {
    const bridge = new BrowserBridge();
    const controller = new AbortController();
    let event: AgentEvent | undefined;
    const pending = bridge.request({
      runId: "run-browser",
      action: "context",
      arguments: {},
      signal: controller.signal,
      emit: (value) => { event = value; },
    });
    if (event?.type !== "browser.request") throw new Error("Expected a browser request event");
    const signal = bridge.signalForRequest(event.request.id);
    expect(signal?.aborted).toBe(false);

    expect(bridge.resolve(event.request.id, { result: { ok: true } })).toBe(true);
    expect(bridge.resolve(event.request.id, { result: { ok: false } })).toBe(false);
    await expect(pending).resolves.toEqual({ ok: true });
    controller.abort();
    bridge.cancelRun("run-browser");
    expect(signal?.aborted).toBe(false);
    expect(bridge.signalForRequest(event.request.id)).toBeUndefined();
    expect(bridge.signalForRequest("unknown-request")).toBeUndefined();
  });

  it("cleans up a request when its run is aborted", async () => {
    const bridge = new BrowserBridge();
    const controller = new AbortController();
    let requestId = "";
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const pending = bridge.request({
      runId: "run-cancelled",
      action: "click",
      arguments: { selector: "#save" },
      signal: controller.signal,
      emit: (event) => {
        if (event.type === "browser.request") requestId = event.request.id;
      },
    });
    const signal = bridge.signalForRequest(requestId);
    expect(signal?.aborted).toBe(false);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ name: "AbortError" });
    expect(bridge.signalForRequest(requestId)).toBeUndefined();
    expect(removeListener).toHaveBeenCalled();
    expect(bridge.resolve(requestId, { result: { clicked: true } })).toBe(false);
  });

  it("does not leave a pending request when event delivery fails", async () => {
    const bridge = new BrowserBridge(10);
    let requestId = "";
    let signal: AbortSignal | undefined;
    const pending = bridge.request({
      runId: "run-closed",
      action: "context",
      arguments: {},
      emit: (event) => {
        if (event.type === "browser.request") {
          requestId = event.request.id;
          signal = bridge.signalForRequest(requestId);
        }
        throw new Error("Browser transport closed");
      },
    });

    await expect(pending).rejects.toThrow("Browser transport closed");
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ message: "Browser transport closed" });
    expect(bridge.signalForRequest(requestId)).toBeUndefined();
    expect(bridge.cancelRun("run-closed")).toBeUndefined();
  });

  it("times out and cleans up an unanswered browser request", async () => {
    const bridge = new BrowserBridge(10);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let requestId = "";
    const pending = bridge.request({
      runId: "run-timeout",
      action: "wait_for",
      arguments: { selector: "#ready" },
      signal: controller.signal,
      emit: (event) => {
        if (event.type === "browser.request") requestId = event.request.id;
      },
    });
    const signal = bridge.signalForRequest(requestId);

    await expect(pending).rejects.toMatchObject({ code: "BROWSER_TIMEOUT", status: 408 });
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ code: "BROWSER_TIMEOUT" });
    expect(bridge.signalForRequest(requestId)).toBeUndefined();
    expect(removeListener).toHaveBeenCalled();
    expect(bridge.resolve(requestId, { result: true })).toBe(false);
  });

  it("cancels only the requested run and ignores a driver's synchronous abort result", async () => {
    const bridge = new BrowserBridge();
    const requests = new Map<string, { id: string; signal: AbortSignal }>();
    const lateResults: boolean[] = [];
    const request = (runId: string) => bridge.request({
      runId,
      action: "navigate",
      arguments: { url: "http://localhost:3000/" },
      emit: (event) => {
        if (event.type !== "browser.request") return;
        const signal = bridge.signalForRequest(event.request.id);
        if (!signal) throw new Error("Expected an execution signal during dispatch");
        requests.set(runId, { id: event.request.id, signal });
        signal.addEventListener("abort", () => {
          lateResults.push(bridge.resolve(event.request.id, { error: "Navigation aborted" }));
        }, { once: true });
      },
    });
    const cancelled = request("cancelled-run");
    const unaffected = request("other-run");

    bridge.cancelRun("cancelled-run");

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(requests.get("cancelled-run")?.signal.aborted).toBe(true);
    expect(lateResults).toEqual([false]);
    expect(bridge.signalForRequest(requests.get("cancelled-run")!.id)).toBeUndefined();
    const other = requests.get("other-run")!;
    expect(other.signal.aborted).toBe(false);
    expect(bridge.resolve(other.id, { result: true })).toBe(true);
    await expect(unaffected).resolves.toBe(true);
  });

  it("does not dispatch a request that was already aborted", async () => {
    const bridge = new BrowserBridge();
    const emit = vi.fn();
    await expect(bridge.request({
      runId: "cancelled-run",
      action: "context",
      arguments: {},
      signal: AbortSignal.abort(),
      emit,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(emit).not.toHaveBeenCalled();
  });
});
