import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopBrowser } from "./desktop-browser";

const contents = vi.hoisted(() => ({
  id: 1, on: vi.fn(), once: vi.fn(), removeListener: vi.fn(), setWindowOpenHandler: vi.fn(),
  session: { setPermissionRequestHandler: vi.fn() },
  navigationHistory: { canGoBack: vi.fn(() => false), canGoForward: vi.fn(() => false), goBack: vi.fn(), goForward: vi.fn(), clear: vi.fn() },
  getURL: vi.fn(() => "http://localhost:5173/"), getTitle: vi.fn(() => "Test"), isLoading: vi.fn(() => false),
  focus: vi.fn(), executeJavaScriptInIsolatedWorld: vi.fn(),
  executeJavaScript: vi.fn(), capturePage: vi.fn(), loadURL: vi.fn().mockResolvedValue(undefined), stop: vi.fn(),
  isDestroyed: vi.fn(() => false), reload: vi.fn(), sendInputEvent: vi.fn(),
}));
vi.mock("electron", () => ({
  WebContentsView: class {
    webContents = contents;
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  contents.getURL.mockReturnValue("http://localhost:5173/");
  contents.navigationHistory.canGoBack.mockReturnValue(false);
  contents.navigationHistory.canGoForward.mockReturnValue(false);
  contents.executeJavaScript.mockReset();
  contents.isLoading.mockReturnValue(false);
  contents.isDestroyed.mockReturnValue(false);
});

afterEach(() => vi.useRealTimers());

describe("desktop browser boundary", () => {
  it("cancels a preview page that is still loading", async () => {
    const controller = new AbortController();
    let rejectLoad!: (error: Error) => void;
    contents.loadURL.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLoad = reject; }));
    contents.stop.mockImplementationOnce(() => rejectLoad(new Error("Navigation aborted")));
    const browser = new DesktopBrowser(vi.fn());
    const navigation = browser.navigate("http://localhost:5173/", controller.signal);
    controller.abort();
    await expect(navigation).rejects.toMatchObject({ name: "AbortError" });
    expect(contents.stop).toHaveBeenCalledOnce();
  });

  it.each(["will-navigate", "will-redirect"])("blocks an external main-frame destination through %s", (name) => {
    const onState = vi.fn();
    new DesktopBrowser(onState);
    const handler = contents.on.mock.calls.find(([event]) => event === name)![1] as (...args: unknown[]) => void;
    const event = { preventDefault: vi.fn() };
    handler(event, "https://example.com/", false, true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ error: "Navigation outside localhost was blocked." }));
  });

  it("allows redirects between localhost pages", () => {
    new DesktopBrowser(vi.fn());
    const handler = contents.on.mock.calls.find(([event]) => event === "will-redirect")![1] as (...args: unknown[]) => void;
    const event = { preventDefault: vi.fn() };
    handler(event, "http://127.0.0.1:5173/login", false, true);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("refuses to inspect or capture an unexpected external page", async () => {
    const browser = new DesktopBrowser(vi.fn());
    contents.getURL.mockReturnValue("https://example.com/");
    await expect(browser.execute("context", {})).rejects.toThrow("restricted");
    await expect(browser.execute("screenshot", {})).rejects.toThrow("restricted");
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
    expect(contents.capturePage).not.toHaveBeenCalled();
    await browser.navigate("http://localhost:5173/");
    expect(contents.loadURL).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("clears the previous project page and navigation history", async () => {
    const browser = new DesktopBrowser(vi.fn());
    await browser.reset();
    expect(contents.stop).toHaveBeenCalledOnce();
    expect(contents.loadURL).toHaveBeenCalledWith("about:blank");
    expect(contents.navigationHistory.clear).toHaveBeenCalledOnce();
    contents.getURL.mockReturnValue("about:blank");
    expect(browser.state().url).toBe("");
  });

  it("bounds screenshot dimensions before encoding the image", async () => {
    const bounded = { toJPEG: vi.fn(() => Buffer.from("image")) };
    const image = { getSize: () => ({ width: 3840, height: 2160 }), resize: vi.fn(() => bounded) };
    contents.capturePage.mockResolvedValue(image);
    const browser = new DesktopBrowser(vi.fn());
    expect(await browser.execute("screenshot", {})).toMatchObject({ dataUrl: "data:image/jpeg;base64,aW1hZ2U=" });
    expect(image.resize).toHaveBeenCalledWith({ width: 1600, height: 900 });
  });
});

describe("agent browser cancellation", () => {
  it.each(["click", "type", "hover", "focus", "scroll", "key"] as const)("does not leave %s queued in a loading page after cancellation", async (action) => {
    contents.isLoading.mockReturnValue(true);
    const controller = new AbortController();
    const browser = new DesktopBrowser(vi.fn());
    const pending = browser.execute(action, { selector: "#save", text: "Hello", key: "Enter" }, controller.signal);
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
    expect(contents.sendInputEvent).not.toHaveBeenCalled();

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    contents.isLoading.mockReturnValue(false);
    const ready = contents.once.mock.calls.find(([name]) => name === "did-stop-loading")![1] as () => void;
    ready();
    await Promise.resolve();

    expect(contents.executeJavaScript).not.toHaveBeenCalled();
    expect(contents.sendInputEvent).not.toHaveBeenCalled();
    expect(contents.removeListener).toHaveBeenCalledWith("did-stop-loading", ready);
    expect(contents.stop).not.toHaveBeenCalled();
  });

  it("delivers an input once the page is ready", async () => {
    contents.isLoading.mockReturnValue(true);
    contents.executeJavaScript.mockResolvedValue({ applied: true });
    const browser = new DesktopBrowser(vi.fn());
    const pending = browser.execute("click", { selector: "#save" }, new AbortController().signal);
    expect(contents.executeJavaScript).not.toHaveBeenCalled();

    contents.isLoading.mockReturnValue(false);
    const ready = contents.once.mock.calls.find(([name]) => name === "did-stop-loading")![1] as () => void;
    ready();

    await expect(pending).resolves.toEqual({ applied: true });
    expect(contents.executeJavaScript).toHaveBeenCalledOnce();
  });

  it("rechecks cancellation when loading ends before dispatching an input", async () => {
    contents.isLoading.mockReturnValue(true);
    const controller = new AbortController();
    const browser = new DesktopBrowser(vi.fn());
    const pending = browser.execute("click", { selector: "#save" }, controller.signal);

    contents.isLoading.mockReturnValue(false);
    const ready = contents.once.mock.calls.find(([name]) => name === "did-stop-loading")![1] as () => void;
    ready();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
  });

  it.each(["navigate", "refresh", "click", "type", "key", "wait_for"] as const)("does not dispatch an already cancelled %s", async (action) => {
    const controller = new AbortController();
    controller.abort();
    const browser = new DesktopBrowser(vi.fn());

    await expect(browser.execute(action, { url: "http://localhost:5173/", selector: "#save", text: "Hello", key: "Enter" }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });

    expect(contents.loadURL).not.toHaveBeenCalled();
    expect(contents.reload).not.toHaveBeenCalled();
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
    expect(contents.sendInputEvent).not.toHaveBeenCalled();
  });

  it("stops agent navigation even if Electron never settles the load promise", async () => {
    const controller = new AbortController();
    contents.loadURL.mockImplementationOnce(() => new Promise(() => {}));
    const browser = new DesktopBrowser(vi.fn());
    const navigation = browser.execute("navigate", { url: "http://localhost:5173/" }, controller.signal);

    controller.abort();

    await expect(navigation).rejects.toMatchObject({ name: "AbortError" });
    expect(contents.stop).toHaveBeenCalledOnce();
  });

  it("does not stop a later page load when a completed navigation's signal is cancelled", async () => {
    const controller = new AbortController();
    const browser = new DesktopBrowser(vi.fn());
    await browser.execute("navigate", { url: "http://localhost:5173/" }, controller.signal);

    controller.abort();

    expect(contents.stop).not.toHaveBeenCalled();
  });

  it.each(["back", "forward", "refresh"] as const)("cancels %s and removes its pending navigation listeners and timer", async (action) => {
    vi.useFakeTimers();
    contents.navigationHistory.canGoBack.mockReturnValue(true);
    contents.navigationHistory.canGoForward.mockReturnValue(true);
    const controller = new AbortController();
    const browser = new DesktopBrowser(vi.fn());
    const navigation = browser.execute(action, {}, controller.signal);

    controller.abort();

    await expect(navigation).rejects.toMatchObject({ name: "AbortError" });
    expect(contents.stop).toHaveBeenCalledOnce();
    expect(contents.removeListener.mock.calls.map(([name]) => name)).toEqual(["did-finish-load", "did-navigate-in-page", "did-fail-load"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes cancellation handling when a reload finishes successfully", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const browser = new DesktopBrowser(vi.fn());
    const navigation = browser.execute("refresh", {}, controller.signal);
    const finished = contents.once.mock.calls.find(([name]) => name === "did-finish-load")![1] as () => void;
    finished();
    await expect(navigation).resolves.toMatchObject({ url: "http://localhost:5173/" });

    controller.abort();

    expect(contents.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a reload that exceeds its navigation deadline", async () => {
    vi.useFakeTimers();
    const browser = new DesktopBrowser(vi.fn());
    const navigation = expect(browser.execute("refresh", {})).rejects.toThrow("Browser navigation did not finish in time.");

    await vi.advanceTimersByTimeAsync(30_000);

    await navigation;
    expect(contents.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an element wait while page inspection is pending", async () => {
    vi.useFakeTimers();
    contents.executeJavaScript.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const browser = new DesktopBrowser(vi.fn());
    const waiting = browser.execute("wait_for", { selector: "#ready" }, controller.signal);

    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(contents.executeJavaScript).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops polling for an element after cancellation between inspections", async () => {
    contents.executeJavaScript.mockResolvedValue({ ready: false, matches: 0 });
    const controller = new AbortController();
    const browser = new DesktopBrowser(vi.fn());
    const waiting = browser.execute("wait_for", { selector: "#ready" }, controller.signal);
    await delay(10);

    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await delay(100);
    expect(contents.executeJavaScript).toHaveBeenCalledOnce();
  });

  it("returns the same element-wait result when the element appears", async () => {
    contents.executeJavaScript.mockResolvedValueOnce({ ready: false, matches: 0 }).mockResolvedValueOnce({ ready: true, matches: 1 });
    const browser = new DesktopBrowser(vi.fn());

    await expect(browser.execute("wait_for", { selector: "#ready", state: "visible" }))
      .resolves.toMatchObject({ selector: "#ready", state: "visible", matches: 1, elapsedMs: expect.any(Number) });
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("times out an element inspection even when Electron does not answer", async () => {
    vi.useFakeTimers();
    contents.executeJavaScript.mockImplementationOnce(() => new Promise(() => {}));
    const browser = new DesktopBrowser(vi.fn());
    const waiting = expect(browser.execute("wait_for", { selector: "#ready", timeoutMs: 100 }))
      .rejects.toThrow("Timed out waiting for #ready to become visible.");

    await vi.advanceTimersByTimeAsync(100);

    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });
});


describe("element picker", () => {
  it("returns the chosen element from an isolated page world", async () => {
    const selection = { url: "http://localhost:5173/", selector: "#save", tagName: "button", text: "Save" };
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(selection);
    await expect(new DesktopBrowser(vi.fn()).pickElement()).resolves.toEqual(selection);
    expect(contents.focus).toHaveBeenCalledOnce();
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(999, [{ code: expect.stringContaining("pointermove") }]);
  });
  it("returns no element when selection is cancelled", async () => {
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(null);
    await expect(new DesktopBrowser(vi.fn()).pickElement()).resolves.toBeNull();
  });
  it("refuses selection on external pages", async () => {
    contents.getURL.mockReturnValue("https://example.com/");
    await expect(new DesktopBrowser(vi.fn()).pickElement()).rejects.toThrow("restricted");
    expect(contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });
});
