import { describe, expect, it } from "vitest";
import { buildRobustSelector } from "./browser-selector.js";

interface FakeElement {
  readonly tagName: string;
  readonly classList: string[];
  readonly children: FakeElement[];
  parentElement: FakeElement | null;
  readonly ownerDocument: null;
  getAttribute(name: string): string | null;
}

function element(
  tagName: string,
  input: { attributes?: Record<string, string>; classes?: string[] } = {},
): FakeElement {
  const attributes = input.attributes ?? {};
  return {
    tagName: tagName.toUpperCase(),
    classList: input.classes ?? [],
    children: [],
    parentElement: null,
    ownerDocument: null,
    getAttribute: (name) => attributes[name] ?? null,
  };
}

function append(parent: FakeElement, ...children: FakeElement[]): void {
  for (const child of children) {
    child.parentElement = parent;
    parent.children.push(child);
  }
}

function selectorRoot(target: FakeElement, uniqueSelectors: readonly string[]): ParentNode {
  const unique = new Set(uniqueSelectors);
  return {
    querySelectorAll: (selector: string) => unique.has(selector) ? [target] : [],
  } as unknown as ParentNode;
}

function select(target: FakeElement, uniqueSelectors: readonly string[]): string {
  return buildRobustSelector(
    target as unknown as Element,
    selectorRoot(target, uniqueSelectors),
  );
}

describe("buildRobustSelector", () => {
  it("prefers a unique, escaped stable id", () => {
    const target = element("button", { attributes: { id: "save:button" } });
    expect(select(target, ["#save\\:button"])).toBe("#save\\:button");
  });

  it("skips a generated id in favor of a stable test attribute", () => {
    const target = element("button", {
      attributes: { id: ":r123456:", "data-testid": "save-profile" },
      classes: ["primary"],
    });
    const expected = 'button[data-testid="save-profile"]';
    expect(select(target, ["#:r123456:", expected])).toBe(expected);
  });

  it("uses the shortest unique stable class selector", () => {
    const target = element("button", { classes: ["primary", "wide", "css-a1b2c3d4e5"] });
    expect(select(target, ["button.wide", "button.primary"])).toBe("button.wide");
  });

  it("uses a stable ancestor before positional selectors", () => {
    const panel = element("section", { attributes: { "data-testid": "settings" } });
    const target = element("button", { classes: ["action"] });
    append(panel, target);
    const expected = 'section[data-testid="settings"] > button.action';
    expect(select(target, [expected])).toBe(expected);
  });

  it("uses nth-of-type only as a final fallback", () => {
    const parent = element("div");
    const first = element("button");
    const target = element("button");
    append(parent, first, target);
    const expected = "button:nth-of-type(2)";
    expect(select(target, [expected])).toBe(expected);
  });

  it("escapes quotes and control characters in attributes", () => {
    const target = element("button", { attributes: { "aria-label": 'Save "draft"\nnow' } });
    const expected = String.raw`button[aria-label="Save \"draft\"\a now"]`;
    expect(select(target, [expected])).toBe(expected);
  });

  it("remains self-contained when serialized for the desktop page", () => {
    const restored = Function(`return (${buildRobustSelector.toString()});`)() as typeof buildRobustSelector;
    const target = element("input", { attributes: { name: "email" } });
    const expected = 'input[name="email"]';
    expect(restored(
      target as unknown as Element,
      selectorRoot(target, [expected]),
    )).toBe(expected);
  });
});
