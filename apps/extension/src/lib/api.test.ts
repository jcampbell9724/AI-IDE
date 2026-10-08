import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonApiError, DaemonClient, readableError } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DaemonClient errors", () => {
  it("does not send an unsaved command override with project actions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "running" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DaemonClient("http://127.0.0.1:3210", "test-token");

    await client.projectAction("start");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(options.method).toBe("POST");
    expect(options.body).toBeUndefined();
  });

  it("uses the daemon's structured error message and preserves diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "VALIDATION_FAILED",
        message: "Project path is required",
        issues: [{ path: ["path"], message: "Required" }],
      },
    }), {
      status: 400,
      statusText: "Bad Request",
      headers: { "Content-Type": "application/json" },
    })));
    const client = new DaemonClient("http://127.0.0.1:3210", "test-token");

    const error = await rejectedError(client.selectProject({ path: "" }));

    expect(error).toBeInstanceOf(DaemonApiError);
    expect(error).toMatchObject({
      message: "Project path is required",
      status: 400,
      code: "VALIDATION_FAILED",
      issues: [{ path: ["path"], message: "Required" }],
    });
    expect(readableError(error)).toBe("Project path is required");
  });

  it("keeps a short plain-text daemon error but does not expose an HTML error page", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("Service is warming up", { status: 503 }))
      .mockResolvedValueOnce(new Response("<!doctype html><h1>Proxy failure</h1>", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DaemonClient("http://localhost:3210", "test-token");

    await expect(client.getProject()).rejects.toThrow("Service is warming up");
    await expect(client.getProject()).rejects.toThrow(
      "The local daemon reported an internal error (502). Check its logs and try again.",
    );
  });

  it("provides actionable fallbacks for empty HTTP and network failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401, statusText: "Unauthorized" }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DaemonClient("http://127.0.0.1:3210", "wrong-token");

    await expect(client.getProject()).rejects.toThrow(
      "The local daemon rejected the request. Check the bearer token in Settings and try again.",
    );
    const networkError = await rejectedError(client.getProject());
    expect(readableError(networkError)).toBe(
      "Couldn’t reach the local daemon. Make sure it is running and the URL in Settings is correct.",
    );
  });

  it("reports malformed successful JSON without leaking parser internals", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    const client = new DaemonClient("http://127.0.0.1:3210", "test-token");

    const error = await rejectedError(client.getProject());

    expect(error).toMatchObject({
      message: "The local daemon returned an invalid JSON response. Check its logs and try again.",
      status: 200,
      code: "INVALID_RESPONSE",
    });
  });

  it("reports an event stream that closes without a terminal run event", async () => {
    const started = {
      type: "run.started",
      runId: "5f2ba5f7-9c48-4ad0-a2a3-30ecad29fc74",
      timestamp: new Date().toISOString(),
      sessionId: "session",
      model: "provider/model",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `event: run.started\ndata: ${JSON.stringify(started)}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )));
    const client = new DaemonClient("http://127.0.0.1:3210", "test-token");
    const consume = async (): Promise<void> => {
      for await (const _event of client.runAgent({
        runId: started.runId,
        sessionId: "session",
        model: "provider/model",
        messages: [{ role: "user", content: "Hello" }],
        context: { elements: [], visualChanges: [], attachments: [] },
        approvalMode: "ask",
      })) {
        // Consume the full stream so an unexpected EOF can be detected.
      }
    };

    const error = await rejectedError(consume());

    expect(error).toMatchObject({
      message: "The agent connection ended before the run finished. Try the request again.",
      status: 502,
      code: "EVENT_STREAM_INCOMPLETE",
    });
  });
});

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected the promise to reject with an Error");
  }
  throw new Error("Expected the promise to reject");
}
