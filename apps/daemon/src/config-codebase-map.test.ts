import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "./config.js";

const originalValue = process.env.BROWSER_AGENT_CODEBASE_MAP_ENABLED;

afterEach(() => {
  if (originalValue === undefined) delete process.env.BROWSER_AGENT_CODEBASE_MAP_ENABLED;
  else process.env.BROWSER_AGENT_CODEBASE_MAP_ENABLED = originalValue;
});

describe("codebase-map daemon configuration", () => {
  it("defaults to disabled", () => {
    delete process.env.BROWSER_AGENT_CODEBASE_MAP_ENABLED;
    expect(readConfig().codebaseMapEnabled).toBe(false);
  });

  it.each([
    ["true", true],
    ["YES", true],
    ["1", true],
    ["false", false],
    ["off", false],
    ["0", false],
  ] as const)("parses %s as %s", (value, expected) => {
    process.env.BROWSER_AGENT_CODEBASE_MAP_ENABLED = value;
    expect(readConfig().codebaseMapEnabled).toBe(expected);
  });

  it("rejects ambiguous values", () => {
    process.env.BROWSER_AGENT_CODEBASE_MAP_ENABLED = "sometimes";
    expect(() => readConfig()).toThrow(/BROWSER_AGENT_CODEBASE_MAP_ENABLED/);
  });
});
