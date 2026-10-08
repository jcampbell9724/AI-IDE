import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewStartup, probePreview } from "./preview-startup";

afterEach(() => vi.useRealTimers());

describe("preview startup", () => {
  it("discovers a delayed backend address and cancels discovery on stop", async () => {
    vi.useFakeTimers();
    let url: string | null = null;
    const navigate = vi.fn().mockResolvedValue(undefined);
    const startup = new PreviewStartup(vi.fn(), vi.fn().mockResolvedValue(true));
    await startup.start(null, async () => {}, () => true, navigate, () => url);
    url = "http://127.0.0.1:8000/";
    await vi.advanceTimersByTimeAsync(500);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(url, expect.any(AbortSignal));
    url = null;
    navigate.mockClear();
    await startup.start(null, async () => {}, () => true, navigate, () => url);
    startup.cancel();
    url = "http://127.0.0.1:9000/";
    await vi.advanceTimersByTimeAsync(1000);
    expect(navigate).not.toHaveBeenCalled();
    expect(startup.state.phase).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("waits through a slow startup before opening the preview once", async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const navigate = vi.fn().mockResolvedValue(undefined);
    const startup = new PreviewStartup(vi.fn(), probe);
    await startup.start("http://localhost:3000", async () => {}, () => true, navigate);
    expect(startup.state.phase).toBe("waiting");
    expect(navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("http://localhost:3000/", expect.any(AbortSignal));
    expect(startup.state.phase).toBe("ready");
  });

  it("keeps a responding saved address ahead of discovered alternatives", async () => {
    vi.useFakeTimers();
    const navigate = vi.fn().mockResolvedValue(undefined);
    const discover = vi.fn(() => "http://localhost:4000/");
    const startup = new PreviewStartup(vi.fn(), vi.fn().mockResolvedValue(true));
    await startup.start("http://localhost:3000", async () => {}, () => true, navigate, discover);
    await vi.advanceTimersByTimeAsync(0);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("http://localhost:3000/", expect.any(AbortSignal));
    expect(discover).not.toHaveBeenCalled();
  });

  it("recovers from a stale saved port using the responding reported address", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async (url: string) => url === "http://localhost:5174/");
    const navigate = vi.fn().mockResolvedValue(undefined);
    const startup = new PreviewStartup(vi.fn(), probe);
    await startup.start("http://localhost:5173", async () => {}, () => true, navigate, () => "http://localhost:5174");
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.mock.calls.map(([url]) => url)).toEqual(["http://localhost:5173/", "http://localhost:5174/"]);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("http://localhost:5174/", expect.any(AbortSignal));
    expect(startup.state).toEqual({ phase: "ready", url: "http://localhost:5174/" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces an unresponsive inferred address when the server reports a new port", async () => {
    vi.useFakeTimers();
    let reported = "http://localhost:3000/";
    const probe = vi.fn(async (url: string) => url === "http://localhost:3001/");
    const navigate = vi.fn().mockResolvedValue(undefined);
    const startup = new PreviewStartup(vi.fn(), probe);
    await startup.start(null, async () => {}, () => true, navigate, () => reported);
    expect(navigate).not.toHaveBeenCalled();
    reported = "http://localhost:3001/";
    await vi.advanceTimersByTimeAsync(500);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(reported, expect.any(AbortSignal));
    expect(startup.state).toEqual({ phase: "ready", url: reported });
  });

  it("uses one timeout for discovery and readiness", async () => {
    vi.useFakeTimers();
    let reported: string | null = null;
    const startup = new PreviewStartup(vi.fn(), vi.fn().mockResolvedValue(false));
    await startup.start(null, async () => {}, () => true, vi.fn(), () => reported);
    await vi.advanceTimersByTimeAsync(59_000);
    reported = "http://localhost:3000/";
    await vi.advanceTimersByTimeAsync(500);
    expect(startup.state).toEqual({ phase: "waiting", url: reported });
    await vi.advanceTimersByTimeAsync(500);
    expect(startup.state.phase).toBe("failed");
    expect(startup.state.message).toContain("60 seconds");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requests a URL when discovery times out without an address", async () => {
    vi.useFakeTimers();
    const startup = new PreviewStartup(vi.fn(), vi.fn());
    await startup.start(null, async () => {}, () => true, vi.fn(), () => null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startup.state).toEqual({ phase: "needs-url" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["discovery", "probe"])("handles background %s errors", async (source) => {
    vi.useFakeTimers();
    const probe = source === "probe" ? vi.fn().mockRejectedValue(new Error("Probe failed")) : vi.fn();
    const discover = () => {
      if (source === "discovery") throw new Error("Discovery failed");
      return "http://localhost:3000/";
    };
    const startup = new PreviewStartup(vi.fn(), probe);
    await startup.start(null, async () => {}, () => true, vi.fn(), discover);
    await vi.advanceTimersByTimeAsync(0);
    expect(startup.state.phase).toBe("failed");
    expect(startup.state.message).toBe(source === "probe" ? "Probe failed" : "Discovery failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports launch failure and never probes", async () => {
    const probe = vi.fn();
    const startup = new PreviewStartup(vi.fn(), probe);
    await expect(startup.start(null, async () => { throw new Error("Command missing"); }, () => false, vi.fn())).rejects.toThrow("Command missing");
    expect(startup.state).toEqual({ phase: "failed", message: "Command missing" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("requests a URL when none is configured", async () => {
    const probe = vi.fn();
    const startup = new PreviewStartup(vi.fn(), probe);
    await startup.start(null, async () => {}, () => true, vi.fn());
    expect(startup.state.phase).toBe("needs-url");
    expect(probe).not.toHaveBeenCalled();
  });

  it("stops waiting when the process exits", async () => {
    vi.useFakeTimers();
    let running = true;
    const navigate = vi.fn();
    const startup = new PreviewStartup(vi.fn(), vi.fn().mockResolvedValue(false));
    await startup.start("http://localhost:3000", async () => {}, () => running, navigate);
    running = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(startup.state.message).toContain("project stopped");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("gives up with guidance instead of waiting forever", async () => {
    vi.useFakeTimers();
    const startup = new PreviewStartup(vi.fn(), vi.fn().mockResolvedValue(false));
    await startup.start("http://localhost:3000", async () => {}, () => true, vi.fn());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startup.state.phase).toBe("failed");
    expect(startup.state.message).toContain("60 seconds");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an in-flight probe without late navigation", async () => {
    let resolveProbe!: (ready: boolean) => void;
    const probe = vi.fn((_url: string, _signal: AbortSignal) => new Promise<boolean>((resolve) => { resolveProbe = resolve; }));
    const navigate = vi.fn();
    const startup = new PreviewStartup(vi.fn(), probe);
    await startup.start("http://localhost:3000", async () => {}, () => true, navigate);
    const signal = probe.mock.calls[0]?.[1];
    startup.cancel();
    resolveProbe(true);
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(startup.state.phase).toBe("idle");
  });

  it("restarting replaces the old wait and only opens the new preview", async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const navigate = vi.fn().mockResolvedValue(undefined);
    const startup = new PreviewStartup(vi.fn(), probe);
    await startup.start("http://localhost:3000", async () => {}, () => true, navigate);
    await startup.start("http://localhost:4000", async () => {}, () => true, navigate);
    await vi.advanceTimersByTimeAsync(1000);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("http://localhost:4000/", expect.any(AbortSignal));
    expect(startup.state.url).toBe("http://localhost:4000/");
  });

  it("ignores a recovered address whose probe finishes after restart", async () => {
    vi.useFakeTimers();
    let resolveRecovered!: (ready: boolean) => void;
    const probe = vi.fn((url: string, _signal: AbortSignal) => url === "http://localhost:3001/"
      ? new Promise<boolean>((resolve) => { resolveRecovered = resolve; })
      : Promise.resolve(url === "http://localhost:4000/"));
    const navigate = vi.fn().mockResolvedValue(undefined);
    const startup = new PreviewStartup(vi.fn(), probe);
    await startup.start("http://localhost:3000", async () => {}, () => true, navigate, () => "http://localhost:3001/");
    await vi.advanceTimersByTimeAsync(0);
    const recoveredSignal = probe.mock.calls.find(([url]) => url === "http://localhost:3001/")?.[1];
    await startup.start("http://localhost:4000", async () => {}, () => true, navigate);
    resolveRecovered(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(recoveredSignal?.aborted).toBe(true);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("http://localhost:4000/", expect.any(AbortSignal));
    expect(startup.state).toEqual({ phase: "ready", url: "http://localhost:4000/" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replace cancelled state when navigation finishes late", async () => {
    vi.useFakeTimers();
    let finishNavigation!: () => void;
    const navigate = vi.fn((_url: string, _signal: AbortSignal) => new Promise<void>((resolve) => { finishNavigation = resolve; }));
    const startup = new PreviewStartup(vi.fn(), vi.fn().mockResolvedValue(true));
    await startup.start(null, async () => {}, () => true, navigate, () => "http://localhost:3000/");
    await vi.advanceTimersByTimeAsync(0);
    startup.cancel();
    finishNavigation();
    await vi.advanceTimersByTimeAsync(0);
    expect(navigate.mock.calls[0]?.[1].aborted).toBe(true);
    expect(startup.state).toEqual({ phase: "idle" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces browser navigation failure instead of announcing readiness", async () => {
    const startup = new PreviewStartup(vi.fn(), vi.fn().mockResolvedValue(true));
    await startup.start("http://localhost:3000", async () => {}, () => true, async () => { throw new Error("Blocked redirect"); });
    await Promise.resolve();
    expect(startup.state.phase).toBe("failed");
    expect(startup.state.message).toBe("Blocked redirect");
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server port");
  return `http://127.0.0.1:${address.port}`;
}

describe("local readiness probe", () => {
  it("waits on server errors and accepts a responding server without following redirects", async () => {
    let status = 503;
    const server = createServer((_request, response) => {
      response.writeHead(status, { Location: "http://example.com" });
      response.end();
    });
    const url = await listen(server);
    try {
      expect(await probePreview(url, new AbortController().signal)).toBe(false);
      status = 200;
      expect(await probePreview(url, new AbortController().signal)).toBe(true);
      status = 302;
      expect(await probePreview(url, new AbortController().signal)).toBe(true);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("aborts a server that never sends headers", async () => {
    const server = createServer(() => {});
    const url = await listen(server);
    const controller = new AbortController();
    try {
      const result = probePreview(url, controller.signal);
      controller.abort();
      expect(await result).toBe(false);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it.each(["https://example.com", "file:///secret", "http://user:pass@localhost"])("rejects unsafe probe target %s", async (url) => {
    await expect(probePreview(url, new AbortController().signal)).rejects.toThrow();
  });
});
