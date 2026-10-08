import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerBrowserRequest } from "./broker";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser broker", () => {
  it("rejects an inactive screenshot target without capturing another tab", async () => {
    const api = installChrome();
    api.tabs.get.mockResolvedValue({ id: 41, windowId: 7, url: "http://localhost:3000/other" });
    await expect(brokerBrowserRequest(message("tabs.screenshot", { tabId: 41 }))).rejects.toThrow("Activate the requested tab");
    expect(api.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(api.tabs.onActivated.removeListener).toHaveBeenCalledOnce();
  });

  it("returns a screenshot with matching active-tab metadata", async () => {
    const api = installChrome();
    api.tabs.captureVisibleTab.mockResolvedValue("data:image/jpeg;base64,aW1hZ2U=");
    await expect(brokerBrowserRequest(message("tabs.screenshot", { tabId: 22 }))).resolves.toMatchObject({
      dataUrl: "data:image/jpeg;base64,aW1hZ2U=", tab: { id: 22, url: "http://localhost:3000" },
    });
    expect(api.tabs.captureVisibleTab).toHaveBeenCalledWith(7, { format: "jpeg", quality: 85 });
    expect(api.tabs.onUpdated.removeListener).toHaveBeenCalledOnce();
  });

  it("discards a screenshot if tabs changed during capture, even if the original tab became active again", async () => {
    const api = installChrome();
    api.tabs.captureVisibleTab.mockImplementation(async () => {
      const onActivated = api.tabs.onActivated.addListener.mock.calls[0]![0] as (info: { tabId: number; windowId: number }) => void;
      onActivated({ tabId: 41, windowId: 7 });
      onActivated({ tabId: 22, windowId: 7 });
      return "wrong pixels";
    });
    await expect(brokerBrowserRequest(message("tabs.screenshot", { tabId: 22 }))).rejects.toThrow("changed during screenshot");
    expect(api.tabs.onActivated.removeListener).toHaveBeenCalledOnce();
  });
  it.each([["tabs.back", "goBack"], ["tabs.forward", "goForward"], ["tabs.reload", "reload"]] as const)(
    "%s operates on the requested tab even when another tab is active", async (command, method) => {
      const api = installChrome();
      api.tabs.get.mockResolvedValue({ id: 41, windowId: 7, url: "http://localhost:3000/form" });
      await brokerBrowserRequest(message(command, { tabId: 41 }));
      expect(api.tabs[method]).toHaveBeenCalledWith(41);
    },
  );
  it("surfaces content-script application errors without reinjecting or retrying", async () => {
    const api = installChrome();
    api.tabs.sendMessage.mockResolvedValue({ error: "No page element matches the interaction selector." });

    await expect(brokerBrowserRequest(message("content.interaction.click", { selector: "#missing" })))
      .rejects.toThrow("No page element matches the interaction selector.");

    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    expect(api.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("injects the page helper once after a transport failure and retries the command", async () => {
    const api = installChrome();
    api.tabs.sendMessage
      .mockRejectedValueOnce(new Error("Receiving end does not exist"))
      .mockResolvedValueOnce({ clicked: true });

    await expect(brokerBrowserRequest(message("content.interaction.click", { selector: "#save" })))
      .resolves.toEqual({ clicked: true });

    expect(api.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(api.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not retry a transport failure after the target page changes", async () => {
    const api = installChrome();
    api.tabs.get
      .mockResolvedValueOnce({ id: 22, windowId: 7, url: "http://localhost:3000/old" })
      .mockResolvedValueOnce({ id: 22, windowId: 7, url: "http://localhost:3000/new" });
    api.tabs.sendMessage.mockRejectedValueOnce(new Error("The frame was removed"));

    await expect(brokerBrowserRequest(message("content.interaction.click", { selector: "#save" })))
      .rejects.toThrow("page changed");

    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    expect(api.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("locks an action to an explicitly requested tab in the current window", async () => {
    const api = installChrome();
    api.tabs.get.mockResolvedValue({ id: 41, windowId: 7, url: "http://localhost:3000/form" });
    api.tabs.update.mockResolvedValue({ id: 41, windowId: 7, url: "http://localhost:3000/next" });

    await brokerBrowserRequest(message("tabs.navigate", {
      tabId: 41,
      url: "http://localhost:3000/next",
    }));

    expect(api.tabs.update).toHaveBeenCalledWith(41, { url: "http://localhost:3000/next" });
  });

  it("rejects a requested tab from a different window", async () => {
    const api = installChrome();
    api.tabs.get.mockResolvedValue({ id: 41, windowId: 99, url: "http://localhost:3000" });

    await expect(brokerBrowserRequest(message("tabs.navigate", {
      tabId: 41,
      url: "http://localhost:3000/next",
    }))).rejects.toThrow("not in the current window");

    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it("captures page context and tab identity in one broker operation", async () => {
    const api = installChrome();
    api.tabs.sendMessage.mockResolvedValue([{ selector: "#save" }]);

    await expect(brokerBrowserRequest(message("page.context"))).resolves.toEqual({
      tab: expect.objectContaining({ id: 22, windowId: 7 }),
      elements: [{ selector: "#save" }],
    });

    expect(api.tabs.query).toHaveBeenCalledTimes(1);
  });
});

function message(command: string, params: Record<string, unknown> = {}) {
  return {
    type: "browser.request" as const,
    request: { id: "request-1", command, params },
  };
}

function installChrome() {
  const tabs = {
    onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    query: vi.fn().mockResolvedValue([{ id: 22, windowId: 7, url: "http://localhost:3000", title: "App" }]),
    get: vi.fn().mockResolvedValue({ id: 22, windowId: 7, url: "http://localhost:3000", title: "App" }),
    update: vi.fn(),
    reload: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    captureVisibleTab: vi.fn(),
    sendMessage: vi.fn(),
  };
  const scripting = { executeScript: vi.fn().mockResolvedValue([]) };
  vi.stubGlobal("chrome", {
    tabs,
    scripting,
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(),
      getTargets: vi.fn().mockResolvedValue([]),
    },
  });
  return { tabs, scripting };
}
