import { PreviewHistory, type PreviewDelta } from "./history";

const STYLE_LAYER_ID = "__browser_agent_preview_styles__";
const ALLOWED_PROPERTIES = new Set([
  "background-color",
  "border-color",
  "border-radius",
  "border-style",
  "border-width",
  "box-shadow",
  "color",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "gap",
  "height",
  "justify-content",
  "letter-spacing",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-width",
  "min-height",
  "opacity",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
  "transform",
  "visibility",
  "width",
]);

export class PreviewEditor {
  private readonly history = new PreviewHistory();

  apply(selectors: string[], rawProperty: string, value: string): PreviewDelta[] {
    const property = toKebabCase(rawProperty);
    assertSafeDeclaration(property, value);
    const deltas: PreviewDelta[] = [];

    for (const selector of [...new Set(selectors)]) {
      let element: Element | null;
      try {
        element = document.querySelector(selector);
      } catch {
        throw new Error("Invalid element selector: " + selector);
      }
      if (!element) continue;
      const previousValue = getComputedStyle(element).getPropertyValue(property).trim();
      deltas.push({
        id: crypto.randomUUID(),
        selector,
        property,
        value,
        previousValue,
        timestamp: Date.now(),
      });
    }

    if (!deltas.length) throw new Error("No selected elements are currently present on the page.");
    this.history.push(deltas);
    this.render();
    return this.history.snapshot();
  }

  undo(): PreviewDelta[] {
    this.history.undo();
    this.render();
    return this.history.snapshot();
  }

  redo(): PreviewDelta[] {
    this.history.redo();
    this.render();
    return this.history.snapshot();
  }

  discard(): PreviewDelta[] {
    this.history.clear();
    document.getElementById(STYLE_LAYER_ID)?.remove();
    return [];
  }

  deltas(): PreviewDelta[] {
    return this.history.snapshot();
  }

  private render(): void {
    const deltas = this.history.snapshot();
    if (!deltas.length) {
      document.getElementById(STYLE_LAYER_ID)?.remove();
      return;
    }

    const current = new Map<string, PreviewDelta>();
    for (const delta of deltas) current.set(delta.selector + "\u0000" + delta.property, delta);
    const rules = [...current.values()].map((delta) => {
      return delta.selector + " { " + delta.property + ": " + delta.value + " !important; }";
    });
    const layer = ensureStyleLayer();
    layer.textContent = rules.join("\n");
  }
}

function ensureStyleLayer(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_LAYER_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  const layer = document.createElement("style");
  layer.id = STYLE_LAYER_ID;
  layer.dataset.browserAgentTemporary = "preview";
  (document.head ?? document.documentElement).append(layer);
  return layer;
}

function assertSafeDeclaration(property: string, value: string): void {
  if (!ALLOWED_PROPERTIES.has(property)) throw new Error("Visual property is not allowlisted: " + property);
  if (!value.trim() || value.length > 256 || /[{};]/.test(value) || /url\s*\(/i.test(value)) {
    throw new Error("Visual value is empty or unsafe.");
  }
  if (globalThis.CSS?.supports && !CSS.supports(property, value)) {
    throw new Error("The browser does not accept that CSS value.");
  }
}

function toKebabCase(value: string): string {
  return value.trim().replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase()).toLowerCase();
}
