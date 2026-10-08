import { describe, expect, it } from "vitest";
import { deriveReadiness, isSupportedActiveTabUrl, type ReadinessInput } from "./readiness";

const READY_INPUT: ReadinessInput = {
  daemonConnected: true,
  token: "pairing-token",
  selectedModel: "provider/tool-model",
  projectPath: "C:\\projects\\demo",
  activeTabUrl: "http://127.0.0.1:4173/",
  contentReady: true,
};

describe("deriveReadiness", () => {
  it("starts with token setup when nothing is configured", () => {
    const state = deriveReadiness({ daemonConnected: false, contentReady: false });

    expect(state.ready).toBe(false);
    expect(state.completed).toBe(0);
    expect(state.total).toBe(5);
    expect(state.summary).toBe("5 setup steps remaining");
    expect(state.nextStep).toMatchObject({
      id: "token",
      actionLabel: "Add your daemon token",
      targetTab: "Settings",
    });
    expect(state.nextTargetTab).toBe("Settings");
  });

  it.each([
    [{ ...READY_INPUT, daemonConnected: false }, "daemon", "Connections"],
    [{ ...READY_INPUT, selectedModel: "" }, "model", "Models"],
    [{ ...READY_INPUT, projectPath: "   " }, "project", "Project"],
    [{ ...READY_INPUT, contentReady: false }, "page", "Connections"],
  ] as const)("points to the first incomplete prerequisite", (input, stepId, targetTab) => {
    const state = deriveReadiness(input);

    expect(state.ready).toBe(false);
    expect(state.nextStep?.id).toBe(stepId);
    expect(state.nextTargetTab).toBe(targetTab);
  });

  it("requires a real web URL as well as a responsive content helper", () => {
    const state = deriveReadiness({
      ...READY_INPUT,
      activeTabUrl: "chrome://extensions",
      contentReady: true,
    });

    expect(state.steps.find((step) => step.id === "page")).toMatchObject({
      complete: false,
      actionLabel: "Open a web page to work on",
    });
    expect(state.nextStep?.id).toBe("page");
  });

  it("reports a fully ready setup", () => {
    const state = deriveReadiness(READY_INPUT);

    expect(state.ready).toBe(true);
    expect(state.completed).toBe(5);
    expect(state.summary).toBe("Ready to build");
    expect(state.nextStep).toBeUndefined();
    expect(state.nextTargetTab).toBeUndefined();
    expect(state.steps.every((step) => step.complete)).toBe(true);
  });
});

describe("isSupportedActiveTabUrl", () => {
  it("accepts HTTP(S) pages and rejects browser pages or malformed values", () => {
    expect(isSupportedActiveTabUrl("http://localhost:4173")).toBe(true);
    expect(isSupportedActiveTabUrl("https://example.test/app")).toBe(true);
    expect(isSupportedActiveTabUrl("chrome://extensions")).toBe(false);
    expect(isSupportedActiveTabUrl("not a URL")).toBe(false);
    expect(isSupportedActiveTabUrl(" ")).toBe(false);
  });
});
