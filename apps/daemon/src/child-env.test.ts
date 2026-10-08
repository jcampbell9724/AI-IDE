import { describe, expect, it } from "vitest";
import { sanitizedChildEnvironment } from "./child-env.js";

describe("sanitizedChildEnvironment", () => {
  it("removes daemon and provider credentials without mutating the source", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "test-path",
      BROWSER_AGENT_TOKEN: "daemon-secret",
      OPENROUTER_API_KEY: "provider-secret",
      PROJECT_SETTING: "visible",
    };

    expect(sanitizedChildEnvironment(source)).toEqual({
      PATH: "test-path",
      PROJECT_SETTING: "visible",
    });
    expect(source).toMatchObject({
      BROWSER_AGENT_TOKEN: "daemon-secret",
      OPENROUTER_API_KEY: "provider-secret",
    });
  });

  it("compares protected names case-insensitively and omits undefined values", () => {
    expect(
      sanitizedChildEnvironment({
        browser_agent_token: "daemon-secret",
        OpenRouter_Api_Key: "provider-secret",
        EMPTY: undefined,
        SAFE: "kept",
      }),
    ).toEqual({ SAFE: "kept" });
  });
});
