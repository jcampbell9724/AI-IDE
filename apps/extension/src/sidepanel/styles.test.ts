import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");

describe("side-panel style semantics", () => {
  it("does not let a broad button selector override tabs, chips, or destructive actions", () => {
    expect(styles).not.toMatch(/button:not\([^}]+\)\s*\{/);
    expect(styles).toContain(".button.primary");
    expect(styles).toContain(".button.secondary");
    expect(styles).toContain(".button.danger");
    expect(styles).toContain(".nav-tab.active");
  });

  it("keeps the narrow side panel shrinkable and keyboard focus visible", () => {
    expect(styles).toMatch(/html, body, #root \{[^}]*min-width: 0/);
    expect(styles).toContain(":focus-visible");
  });

  it("keeps the header and composer available while the conversation grows", () => {
    expect(styles).toMatch(/\.app-header \{[^}]*position: sticky/);
    expect(styles).toMatch(/\.composer \{[^}]*position: sticky/);
  });

  it("bounds and independently scrolls the conversation history", () => {
    expect(styles).toMatch(/\.chat-history-panel \{[^}]*max-height: 220px[^}]*overflow: hidden/);
    expect(styles).toMatch(/\.chat-history-list \{[^}]*min-height: 0[^}]*overflow-y: auto/);
  });
});
