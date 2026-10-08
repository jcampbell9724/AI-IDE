import { describe, expect, it } from "vitest";
import { normalizeDaemonUrl } from "./settings";

describe("normalizeDaemonUrl", () => {
  it("accepts and normalizes loopback HTTP URLs", () => {
    expect(normalizeDaemonUrl("http://localhost:3210/")).toBe("http://localhost:3210");
    expect(normalizeDaemonUrl("http://127.0.0.1:3210/path/")).toBe("http://127.0.0.1:3210/path");
  });

  it("rejects remote, credentialed, and HTTPS daemon URLs", () => {
    expect(() => normalizeDaemonUrl("https://localhost:3210")).toThrow();
    expect(() => normalizeDaemonUrl("http://example.com:3210")).toThrow();
    expect(() => normalizeDaemonUrl("http://user:pass@localhost:3210")).toThrow();
  });
});
