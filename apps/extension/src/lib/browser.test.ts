import { afterEach, describe, expect, it, vi } from "vitest";
import { executeDaemonBrowserRequest } from "./browser";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("daemon browser request adapter", () => {
  it.each([["back", "tabs.back"], ["forward", "tabs.forward"], ["refresh", "tabs.reload"]] as const)(
    "preserves the requested tab for %s", async (action, command) => {
      const sendMessage = installRuntime({});
      await executeDaemonBrowserRequest({ id: "targeted", action, arguments: { tabId: 41 } });
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        request: expect.objectContaining({ command, params: { tabId: 41 } }),
      }));
    },
  );
  it("captures context as one target-stable broker operation", async () => {
    const sendMessage = installRuntime({ tab: { id: 9 }, elements: [] });

    await executeDaemonBrowserRequest({
      id: "request-1",
      action: "context",
      arguments: {},
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ command: "page.context" }),
    }));
  });

  it("routes bounded waits through the allowlisted page helper", async () => {
    const sendMessage = installRuntime({ state: "visible", matches: 1 });

    await executeDaemonBrowserRequest({
      id: "request-2",
      action: "wait_for",
      arguments: { selector: "#ready", state: "visible", timeoutMs: 2_000, tabId: 9 },
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        command: "content.interaction.wait_for",
        params: expect.objectContaining({ selector: "#ready", tabId: 9 }),
      }),
    }));
  });
});

function installRuntime(data: unknown) {
  const sendMessage = vi.fn().mockResolvedValue({ ok: true, data });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  return sendMessage;
}
