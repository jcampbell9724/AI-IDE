import { afterEach, describe, expect, it, vi } from "vitest";
import { appendProjectLogs, watchProjectLogs } from "./project-logs";

const entry = (seq: number, text: string) => ({ seq, text, timestamp: "2026-09-05T00:00:00.000Z", stream: "stdout" as const });
afterEach(() => vi.useRealTimers());

describe("project log output", () => {
  it("preserves streamed chunks and removes terminal color escapes", () => {
    expect(appendProjectLogs("Star", [entry(1, "ting\n\u001b[32mReady\u001b[0m\n")])).toBe("Starting\nReady\n");
  });

  it("bounds the visible output even for very noisy processes", () => {
    const output = appendProjectLogs("x".repeat(190_000), [entry(1, "y".repeat(100_000))]);
    expect(output.length).toBeLessThan(201_000);
    expect(output).toContain("Earlier output trimmed");
    expect(output.endsWith("y".repeat(100_000))).toBe(true);
  });

  it("reads only new output and stops polling on close", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce({ logs: [entry(1, "Ready")], next: 1 }).mockResolvedValue({ logs: [], next: 1 });
    const received = vi.fn();
    const stop = watchProjectLogs(read, received, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect(read.mock.calls).toEqual([[0], [1]]);
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("ignores a late response after switching projects or closing", async () => {
    let resolve!: (value: { logs: ReturnType<typeof entry>[]; next: number }) => void;
    const read = vi.fn(() => new Promise<{ logs: ReturnType<typeof entry>[]; next: number }>((done) => { resolve = done; }));
    const received = vi.fn();
    const stop = watchProjectLogs(read, received, vi.fn());
    stop();
    resolve({ logs: [entry(1, "Old project")], next: 1 });
    await Promise.resolve();
    expect(received).not.toHaveBeenCalled();
  });

  it("recovers from a temporary log-reading error", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new Error("Busy")).mockResolvedValue({ logs: [entry(1, "Recovered")], next: 1 });
    const failed = vi.fn();
    const received = vi.fn();
    const stop = watchProjectLogs(read, received, failed);
    await vi.advanceTimersByTimeAsync(1000);
    expect(failed).toHaveBeenCalledWith("Busy");
    expect(received).toHaveBeenCalledWith([entry(1, "Recovered")]);
    stop();
  });
});
