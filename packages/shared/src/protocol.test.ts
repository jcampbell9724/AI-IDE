import { describe, expect, it } from "vitest";
import {
  AgentRunRequestSchema,
  BrowserActionSchema,
  BrowserResultInputSchema,
  ProjectSelectionRequestSchema,
  ProjectStateSchema,
  ProjectViewSchema,
} from "./protocol.js";

describe("shared protocol validation", () => {
  it("accepts the smallest valid agent run", () => {
    const parsed = AgentRunRequestSchema.parse({
      runId: "run-1",
      sessionId: "session-1",
      model: "provider/model",
      messages: [{ role: "user", content: "Inspect the project" }],
    });

    expect(parsed.approvalMode).toBe("ask");
    expect(parsed.context.elements).toEqual([]);
    expect(parsed.context.visualChanges).toEqual([]);
  });

  it("rejects ambiguous browser results", () => {
    expect(BrowserResultInputSchema.safeParse({}).success).toBe(false);
    expect(BrowserResultInputSchema.safeParse({ result: { ok: true } }).success).toBe(true);
  });

  it("supports bounded waits for dynamic browser elements", () => {
    expect(BrowserActionSchema.parse("wait_for")).toBe("wait_for");
  });

  it("requires an absolute project path to be supplied as a non-empty string", () => {
    expect(ProjectSelectionRequestSchema.safeParse({ path: "" }).success).toBe(false);
    expect(ProjectSelectionRequestSchema.safeParse({ path: "C:\\work\\app" }).success).toBe(true);
  });

  it("distinguishes reopening a project from explicitly restoring command detection", () => {
    expect(ProjectSelectionRequestSchema.parse({ path: "C:\\work\\app" })).not.toHaveProperty("devCommand");
    expect(ProjectSelectionRequestSchema.parse({ path: "C:\\work\\app", devCommand: "   " }).devCommand).toBe("");
  });

  it("allows the authenticated project view to suggest recent folders", () => {
    const parsed = ProjectViewSchema.parse({
      path: null,
      name: null,
      url: null,
      devCommand: null,
      status: "stopped",
      pid: null,
      candidates: [{ path: "C:\\work\\app", name: "app" }],
    });

    expect(parsed.candidates).toEqual([{ path: "C:\\work\\app", name: "app" }]);
  });

  it("loads older project history without requiring pin metadata", () => {
    const parsed = ProjectStateSchema.parse({ current: null, recent: [] });

    expect(parsed.pinned).toEqual([]);
  });
});
