import { describe, expect, it } from "vitest";
import type { ElementContext, ProjectInfo } from "./types";
import { friendlyElementLabel, friendlyProjectStatus, friendlyToolName } from "./presentation";

function element(overrides: Partial<ElementContext> = {}): ElementContext {
  return {
    id: "selection-1",
    selector: "main > button.primary",
    tagName: "BUTTON",
    text: "",
    attributes: {},
    rect: { x: 0, y: 0, width: 100, height: 40 },
    computedStyles: {},
    inlineStyles: {},
    outerHTMLSnippet: "<button></button>",
    pageUrl: "http://localhost:4173",
    ...overrides,
  };
}

describe("friendlyElementLabel", () => {
  it("prefers an accessible label over visible text and selectors", () => {
    expect(friendlyElementLabel(element({
      text: "Save",
      attributes: { "aria-label": "  Save changes  ", id: "save" },
    }))).toBe("Save changes");
  });

  it("uses short, normalized visible text", () => {
    expect(friendlyElementLabel(element({ text: "  Start\n building   now " }))).toBe("Start building now");
  });

  it("falls back through id, class, and tag for elements without short text", () => {
    const longText = "A".repeat(61);
    expect(friendlyElementLabel(element({ text: longText, attributes: { id: "hero-title", class: "title large" } }))).toBe("#hero-title");
    expect(friendlyElementLabel(element({ text: longText, attributes: { class: "card featured" } }))).toBe(".card");
    expect(friendlyElementLabel(element({ tagName: "SECTION" }))).toBe("section");
  });
});

describe("friendlyToolName", () => {
  it.each([
    ["fs_read", "Read file"],
    ["fs_write", "Write file"],
    ["fs_search", "Search project"],
    ["shell_run", "Run command"],
    ["git_status", "Check Git status"],
    ["browser", "Use browser"],
  ])("presents %s as %s", (toolId, label) => {
    expect(friendlyToolName(toolId)).toBe(label);
  });

  it("humanizes unknown tool identifiers", () => {
    expect(friendlyToolName("custom_visual_check")).toBe("Custom visual check");
    expect(friendlyToolName(" ")).toBe("Tool");
  });
});

describe("friendlyProjectStatus", () => {
  const project = (status: ProjectInfo["status"], path?: string): Pick<ProjectInfo, "path" | "status"> => (
    path === undefined ? { status } : { status, path }
  );

  it("explains that a selected stopped project may be running outside the agent", () => {
    expect(friendlyProjectStatus(project("stopped", "C:\\projects\\demo"))).toBe("Selected — not managed here");
  });

  it("distinguishes no selection, active transitions, and failures", () => {
    expect(friendlyProjectStatus(project("unknown"))).toBe("No project selected");
    expect(friendlyProjectStatus(project("running", "C:\\projects\\demo"))).toBe("Running");
    expect(friendlyProjectStatus(project("starting", "C:\\projects\\demo"))).toBe("Starting…");
    expect(friendlyProjectStatus(project("failed", "C:\\projects\\demo"))).toBe("Needs attention");
  });
});
