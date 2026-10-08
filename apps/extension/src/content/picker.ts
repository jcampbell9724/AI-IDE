import { buildRobustSelector } from "./selectors";
import type { ElementContext } from "../lib/types";

const OVERLAY_ID = "__browser_agent_picker_overlay__";
const STYLE_KEYS = [
  "background-color",
  "border-radius",
  "color",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "height",
  "margin",
  "opacity",
  "padding",
  "position",
  "width",
];

export class ElementPicker {
  private active = false;
  private multiple = true;
  private selections: ElementContext[] = [];
  private overlay: HTMLDivElement | undefined;
  private hovered: Element | undefined;

  constructor(private readonly emit: (event: Record<string, unknown>) => void) {}

  start(multiple = true): { active: true } {
    if (this.active) return { active: true };
    this.active = true;
    this.multiple = multiple;
    document.addEventListener("mousemove", this.onMouseMove, true);
    document.addEventListener("click", this.onClick, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    return { active: true };
  }

  stop(): { active: false } {
    if (!this.active) return { active: false };
    this.active = false;
    document.removeEventListener("mousemove", this.onMouseMove, true);
    document.removeEventListener("click", this.onClick, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.overlay?.remove();
    this.overlay = undefined;
    this.hovered = undefined;
    this.emit({ type: "picker.stopped" });
    return { active: false };
  }

  clear(): ElementContext[] {
    this.selections = [];
    this.emit({ type: "selection.cleared" });
    return [];
  }

  remove(id: string): ElementContext[] {
    this.selections = this.selections.filter((element) => element.id !== id);
    this.emit({ type: "selection.removed", elementId: id });
    return this.getSelections();
  }

  getSelections(): ElementContext[] {
    return this.selections.map((selection) => ({
      ...selection,
      attributes: { ...selection.attributes },
      computedStyles: { ...selection.computedStyles },
      inlineStyles: { ...selection.inlineStyles },
      rect: { ...selection.rect },
    }));
  }

  capture(selector?: string): ElementContext[] {
    if (selector) {
      let elements: NodeListOf<Element>;
      try {
        elements = document.querySelectorAll(selector);
      } catch {
        throw new Error("Invalid inspection selector: " + selector);
      }
      if (!elements.length) throw new Error("No page element matches the inspection selector.");
      if (elements.length > 1) {
        throw new Error(`The inspection selector matches ${elements.length} elements; use a unique selector.`);
      }
      return [captureElement(elements[0] as Element)];
    }
    if (this.selections.length) return this.getSelections();
    const fallback = document.activeElement instanceof Element ? document.activeElement : document.body;
    return fallback ? [captureElement(fallback)] : [];
  }

  dispose(): void {
    this.stop();
  }

  private readonly onMouseMove = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element) || target.id === OVERLAY_ID) return;
    this.hovered = target;
    this.positionOverlay(target.getBoundingClientRect());
  };

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element) || target.id === OVERLAY_ID) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!this.multiple) this.clear();
    const context = captureElement(target);
    if (!this.selections.some((item) => item.selector === context.selector)) {
      this.selections = [...this.selections, context];
      this.emit({ type: "selection.added", element: context });
    }
    if (!this.multiple || !event.shiftKey) this.stop();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.stop();
  };

  private positionOverlay(rect: DOMRect): void {
    if (!this.overlay) {
      this.overlay = document.createElement("div");
      this.overlay.id = OVERLAY_ID;
      this.overlay.dataset.browserAgentTemporary = "picker";
      Object.assign(this.overlay.style, {
        background: "rgba(78, 145, 255, 0.14)",
        border: "2px solid #4e91ff",
        boxSizing: "border-box",
        pointerEvents: "none",
        position: "fixed",
        zIndex: "2147483647",
      });
      document.documentElement.append(this.overlay);
    }
    Object.assign(this.overlay.style, {
      left: rect.left + "px",
      top: rect.top + "px",
      width: rect.width + "px",
      height: rect.height + "px",
    });
  }
}

function captureElement(element: Element): ElementContext {
  const rect = element.getBoundingClientRect();
  const computed = getComputedStyle(element);
  const attributes: Record<string, string> = {};
  for (const attribute of [...element.attributes].slice(0, 24)) {
    if (/^(value|nonce|srcdoc)$/i.test(attribute.name) || /^on/i.test(attribute.name)) continue;
    attributes[attribute.name] = attribute.value.slice(0, 300);
  }
  const computedStyles: Record<string, string> = {};
  for (const key of STYLE_KEYS) computedStyles[key] = computed.getPropertyValue(key);
  const inlineStyles: Record<string, string> = {};
  if (element instanceof HTMLElement || element instanceof SVGElement) {
    for (const property of [...element.style]) inlineStyles[property] = element.style.getPropertyValue(property);
  }
  const isPassword = element instanceof HTMLInputElement && element.type === "password";
  return {
    id: crypto.randomUUID(),
    selector: buildRobustSelector(element),
    tagName: element.tagName.toLowerCase(),
    text: isPassword ? "" : (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 500),
    attributes,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    computedStyles,
    inlineStyles,
    outerHTMLSnippet: element.outerHTML.slice(0, 50_000),
    pageUrl: location.href,
  };
}
