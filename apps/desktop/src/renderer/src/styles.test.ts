import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");

function declarationsFor(selector: string): string {
  return [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1]?.split(",").some((candidate) => candidate.trim() === selector))
    .map((match) => match[2] ?? "")
    .join("\n");
}

function declarationValue(rule: string, property: string): string | undefined {
  return rule
    .split(";")
    .map((declaration) => declaration.split(":", 2).map((part) => part.trim()))
    .find(([name]) => name === property)?.[1];
}

function expectNoCardChrome(rule: string): void {
  for (const declaration of rule.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;

    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim().toLowerCase();
    if (property === "border-radius" || property.endsWith("-radius")) {
      expect(value).toMatch(/^(?:0|0px|none)$/);
    } else if (property === "border" || property.startsWith("border-")) {
      expect(value).toMatch(/^(?:0|0px|none|transparent)$/);
    } else if (property === "background" || property.startsWith("background-")) {
      expect(value).toMatch(/^(?:none|transparent)$/);
    } else if (property === "box-shadow") {
      expect(value).toBe("none");
    }
  }
}

describe("desktop split layout", () => {
  it("uses sans-serif for the interface and monospace for technical content", () => {
    expect(declarationsFor(":root")).toContain('font-family: "Segoe UI", Arial, sans-serif');
    expect(styles).not.toContain('font-family: "Bitcount Grid Double"');
  });

  it("sizes navigation separately and protects the right-hand chat", () => {
    expect(declarationsFor(".desktop-workspace")).toContain("grid-template-columns: var(--sidebar-width) minmax(0, 1fr)");
    expect(declarationsFor(".workspace-panes")).toContain("clamp(360px, var(--chat-pane-percent), calc(100% - 367px))");
    expect(declarationsFor(".compact-workspace .workspace-panes")).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("makes the divider visibly draggable without browser gesture interference", () => {
    expect(styles).toMatch(/\.pane-resizer\s*\{[^}]*cursor:\s*col-resize/);
    expect(styles).toMatch(/\.pane-resizer\s*\{[^}]*touch-action:\s*none/);
    expect(styles).toMatch(/\.pane-resizer:hover[^}]*background:/);
  });

  it("expands navigation independently and overlays it on compact windows", () => {
    expect(declarationsFor(".desktop-workspace.history-open")).toContain("--sidebar-width: 340px");
    expect(declarationsFor(".desktop-workspace.sidebar-overlay")).toContain("--sidebar-width: 48px");
    expect(declarationsFor(".sidebar-overlay.history-open > .history-sidebar")).toContain("position: absolute");
  });

  it("provides a bounded central native browser viewport", () => {
    expect(styles).toMatch(/\.browser-pane\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/);
    expect(styles).toMatch(/\.browser-pane\s*\{[^}]*grid-template-rows:\s*auto\s+auto\s+auto\s+minmax\(0,\s*1fr\)/);
    expect(styles).toMatch(/\.browser-viewport\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/);
  });

  it("keeps closable tabs in a dedicated strip above the location toolbar", () => {
    expect(styles).toMatch(/\.workspace-tabbar\s*\{[^}]*overflow:\s*hidden/);
    expect(styles).toMatch(/\.code-tab-close\s*\{[^}]*cursor:\s*pointer/);
    expect(styles).toMatch(/\.code-location\s*\{[^}]*height:\s*30px/);
  });

  it("scrolls history and conversation independently while keeping the composer docked", () => {
    expect(styles).toMatch(/\.conversation-history\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/);
    expect(styles).toMatch(/\.conversation-history ul\s*\{[^}]*overflow-y:\s*auto/);
    expect(styles).toMatch(/\.chat-scroll-region\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
    expect(styles).toMatch(/\.composer-dock\s*\{[^}]*flex:\s*0 0 auto/);
  });

  it("keeps the project tree and code viewer independently scrollable", () => {
    expect(styles).toMatch(/\.project-tree\s*\{[^}]*overflow:\s*auto/);
    expect(styles).toMatch(/\.code-scroll\s*\{[^}]*overflow:\s*auto/);
    expect(styles).toMatch(/\.code-line code\s*\{[^}]*white-space:\s*pre/);
  });

  it("keeps streaming scroll stable and offers a compact return control", () => {
    expect(styles).toMatch(/\.chat-scroll-region\s*\{[^}]*overflow-anchor:\s*none/);
    expect(styles).toMatch(/\.scroll-to-latest\s*\{[^}]*position:\s*absolute/);
  });

  it("uses an automatically sized composer instead of a manual resize handle", () => {
    expect(styles).toMatch(/\.composer textarea\s*\{[^}]*resize:\s*none[^}]*overflow-y:\s*hidden/);
  });

  it("keeps history deletion discoverable without adding persistent chrome", () => {
    expect(styles).toMatch(/\.conversation-delete\s*\{[^}]*opacity:\s*0/);
    expect(styles).toMatch(/\.conversation-history li:hover \.conversation-delete,\s*\.conversation-delete:focus-visible\s*\{[^}]*opacity:\s*1/);
  });

  it("keeps conversation history rows flat instead of turning them into cards", () => {
    for (const selector of [
      ".conversation-history li",
      ".conversation-history li:hover",
      ".conversation-history li.active",
    ]) {
      expectNoCardChrome(declarationsFor(selector));
    }
  });

  it("keeps the chat composer as the intentional input card", () => {
    const composerRule = declarationsFor(".composer");

    expect(declarationValue(composerRule, "border")).toMatch(/^[1-9]/);
    expect(declarationValue(composerRule, "border-radius")).toMatch(/^[1-9]/);
    expect(declarationValue(composerRule, "background")).not.toMatch(/^(?:none|transparent)$/);
    expect(declarationValue(composerRule, "box-shadow")).not.toBe("none");
  });

  it("adds brief surface entrances without animating native browser geometry", () => {
    expect(declarationsFor(".sidebar-panel")).toContain("animation: sidebar-enter var(--motion-enter)");
    for (const selector of [".settings-tab-panel", ".message", ".tool-item", ".chat-feedback", ".settings-feedback", ".scroll-to-latest", ".project-logs"]) {
      expect(declarationsFor(selector)).toContain("animation: surface-enter var(--motion-enter)");
    }
    for (const selector of [".desktop-workspace", ".workspace-content", ".workspace-panes", ".browser-pane", ".viewer-stage", ".browser-viewport"]) {
      expect(declarationsFor(selector)).not.toMatch(/(?:animation|transition|transform):/);
    }
    expect(styles).not.toMatch(/transition:\s*all\b/);
  });

  it("provides smooth control feedback and disables all motion when requested", () => {
    expect(declarationsFor("button")).toContain("color var(--motion-fast)");
    expect(declarationsFor(".composer")).toContain("box-shadow var(--motion-fast)");
    expect(styles).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*, \*::before, \*::after\s*\{[^}]*transition: none !important; animation: none !important/);
  });

  it("honors reduced-motion preferences", () => {
    expect(styles).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/);
    expect(styles).toMatch(/\.stream-cursor\s*\{\s*animation:\s*none/);
  });

  it("adds live feedback motion for runs, tools, and streaming", () => {
    expect(styles).toMatch(/@keyframes tool-pulse/);
    expect(styles).toMatch(/@keyframes run-dot-pulse/);
    expect(styles).toMatch(/@keyframes status-bar-slide/);
    expect(styles).toMatch(/\.tool-item\.running/);
    expect(styles).toMatch(/\.run-status\.starting::after/);
    expect(styles).toMatch(/\.message\.streaming/);
    expect(styles).toMatch(/\.message\.user\s*\{[^}]*animation-name:\s*message-user-enter/);
  });

  it("staggers lists and smooths rows, composer, and reveal controls", () => {
    expect(styles).toMatch(/\.conversation-history ul > li/);
    expect(styles).toMatch(/\.conversation-select,\s*\.project-tree-row/);
    expect(styles).toMatch(/\.composer textarea\s*\{[^}]*transition:\s*height/);
    expect(styles).toMatch(/\.scroll-to-latest\.is-hidden/);
    expect(styles).toMatch(/\.browser-empty,\s*\.preview-startup\s*\{[^}]*animation:\s*preview-enter/);
  });
});
