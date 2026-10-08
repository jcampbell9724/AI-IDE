import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodebaseMapSettings } from "./CodebaseMapSettings";

function render(mapEnabled: boolean, memoryEnabled: boolean, busy = false): string {
  return renderToStaticMarkup(createElement(CodebaseMapSettings, {
    enabled: mapEnabled,
    repositoryMemoryEnabled: memoryEnabled,
    busy,
    onChange: () => {},
    onRepositoryMemoryChange: () => {},
  }));
}

describe("repository context preferences", () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "renders map=%s and memory=%s independently with accessible switches",
    (mapEnabled, memoryEnabled) => {
      const markup = render(mapEnabled, memoryEnabled);
      const switches = markup.match(/<input[^>]*role="switch"[^>]*>/g) ?? [];
      expect(switches).toHaveLength(2);
      expect(switches[0]?.includes('checked=""')).toBe(mapEnabled);
      expect(switches[1]?.includes('checked=""')).toBe(memoryEnabled);
      expect(switches[1]).toContain('aria-describedby="repository-memory-description repository-memory-boundary"');
      expect(markup).toContain("Use repository memory");
      expect(markup).toContain("keeps saved memory for later");
    },
  );

  it("disables both switches while a preference is being saved", () => {
    const switches = render(true, false, true).match(/<input[^>]*role="switch"[^>]*>/g) ?? [];
    expect(switches).toHaveLength(2);
    for (const control of switches) expect(control).toContain('disabled=""');
  });
});
