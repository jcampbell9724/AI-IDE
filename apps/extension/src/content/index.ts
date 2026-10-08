import { PreviewEditor } from "./editor";
import { ElementPicker } from "./picker";

const editor = new PreviewEditor();
const picker = new ElementPicker((event) => {
  void chrome.runtime.sendMessage({ type: "content.event", event }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void handleCommand(message, sender)
    .then((data) => sendResponse(data))
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      sendResponse({ error: detail });
    });
  return true;
});

window.addEventListener("pagehide", () => picker.dispose(), { once: true });

async function handleCommand(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (sender.id !== chrome.runtime.id) throw new Error("Rejected an untrusted content command.");
  if (!message || typeof message !== "object") throw new Error("Malformed content command.");
  const candidate = message as { type?: unknown; command?: unknown; params?: unknown };
  if (candidate.type !== "content.command" || typeof candidate.command !== "string") {
    throw new Error("Malformed content command.");
  }
  const params = isRecord(candidate.params) ? candidate.params : {};

  switch (candidate.command) {
    case "picker.start":
      return picker.start(params.multiple !== false);
    case "picker.stop":
      return picker.stop();
    case "picker.clear":
      return picker.clear();
    case "context.capture":
      return picker.capture(typeof params.selector === "string" ? params.selector : undefined);
    case "selection.remove":
      return picker.remove(requiredString(params, "id"));
    case "edit.apply": {
      const selectors = Array.isArray(params.selectors) ? params.selectors.filter(isString) : [];
      const deltas = editor.apply(selectors, requiredString(params, "property"), requiredString(params, "value"));
      notifyPreviewChanged(deltas);
      return deltas;
    }
    case "edit.undo": {
      const deltas = editor.undo();
      notifyPreviewChanged(deltas);
      return deltas;
    }
    case "edit.redo": {
      const deltas = editor.redo();
      notifyPreviewChanged(deltas);
      return deltas;
    }
    case "edit.discard": {
      const deltas = editor.discard();
      notifyPreviewChanged(deltas);
      return deltas;
    }
    case "edit.deltas":
      return editor.deltas();
    case "interaction.click": {
      const element = targetElement(params);
      if (!(element instanceof HTMLElement)) throw new Error("The requested element cannot be clicked.");
      assertInteractable(element);
      element.click();
      return { clicked: true };
    }
    case "interaction.type": {
      const element = targetElement(params);
      assertInteractable(element);
      const text = requiredText(params, "text", "value");
      setEditableValue(element, text);
      return { typed: text.length };
    }
    case "interaction.key": {
      const element = targetElement(params, true);
      const key = requiredString(params, "key");
      if (key.length > 40) throw new Error("Keyboard key name is too long.");
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
      return { key };
    }
    case "interaction.scroll": {
      if (typeof params.selector === "string") {
        targetElement(params).scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      } else {
        const x = boundedNumber(params.x ?? params.deltaX ?? 0);
        const y = boundedNumber(params.y ?? params.deltaY ?? 0);
        window.scrollBy({ left: x, top: y, behavior: "smooth" });
      }
      return { scrolled: true };
    }
    case "interaction.hover": {
      const element = targetElement(params);
      assertInteractable(element);
      element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: false }));
      return { hovered: true };
    }
    case "interaction.focus": {
      const element = targetElement(params);
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) throw new Error("The requested element cannot be focused.");
      assertInteractable(element);
      element.focus();
      return { focused: true };
    }
    case "interaction.wait_for":
      return waitForElement(params);
    default:
      throw new Error("Content command is not allowlisted: " + candidate.command);
  }
}

function notifyPreviewChanged(deltas: unknown[]): void {
  void chrome.runtime.sendMessage({ type: "content.event", event: { type: "preview.changed", deltas } }).catch(() => undefined);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing string parameter: " + key);
  return value;
}

function requiredText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  throw new Error("Missing string parameter: " + keys[0]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && !!value;
}

function targetElement(params: Record<string, unknown>, allowActive = false): Element {
  if (typeof params.selector !== "string") {
    if (allowActive && document.activeElement) return document.activeElement;
    throw new Error("A selector is required for this interaction.");
  }
  let elements: NodeListOf<Element>;
  try {
    elements = document.querySelectorAll(params.selector);
  } catch {
    throw new Error("Invalid interaction selector.");
  }
  if (!elements.length) throw new Error("No page element matches the interaction selector.");
  if (elements.length > 1) {
    throw new Error(`The interaction selector matches ${elements.length} elements; use a unique selector.`);
  }
  return elements[0] as Element;
}

function setEditableValue(element: Element, text: string): void {
  if (text.length > 100_000) throw new Error("Typed text is too long.");
  if (element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, text);
  } else if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, text);
  } else if (element instanceof HTMLSelectElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(element, text);
  } else if (element instanceof HTMLElement && element.isContentEditable) {
    element.textContent = text;
  } else {
    throw new Error("The requested element is not editable.");
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function assertInteractable(element: Element): void {
  if (!element.isConnected) throw new Error("The requested element is no longer attached to the page.");
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
    throw new Error("The requested element is not visible.");
  }
  if ("disabled" in element && Boolean((element as Element & { disabled?: boolean }).disabled)) {
    throw new Error("The requested element is disabled.");
  }
}

function waitForElement(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const selector = requiredString(params, "selector");
  const requestedTimeout = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
    ? params.timeoutMs
    : 5_000;
  const timeoutMs = Math.max(100, Math.min(15_000, Math.floor(requestedTimeout)));
  const state = typeof params.state === "string" ? params.state : "visible";
  if (!["attached", "visible", "hidden", "detached"].includes(state)) {
    throw new Error("wait_for state must be attached, visible, hidden, or detached.");
  }
  const startedAt = Date.now();
  const inspect = (): { ready: boolean; matches: number } => {
    let elements: Element[];
    try {
      elements = Array.from(document.querySelectorAll(selector));
    } catch {
      throw new Error("Invalid wait_for selector.");
    }
    const visible = elements.some((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    return {
      ready: state === "attached"
        ? elements.length > 0
        : state === "visible"
          ? visible
          : state === "hidden"
            ? !visible
            : elements.length === 0,
      matches: elements.length,
    };
  };

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let settled = false;
    const check = (): void => {
      try {
        const result = inspect();
        if (result.ready) {
          settled = true;
          if (timer !== undefined) clearInterval(timer);
          resolve({ selector, state, matches: result.matches, elapsedMs: Date.now() - startedAt });
        } else if (Date.now() - startedAt >= timeoutMs) {
          settled = true;
          if (timer !== undefined) clearInterval(timer);
          reject(new Error(`Timed out waiting for ${selector} to become ${state}.`));
        }
      } catch (error) {
        settled = true;
        if (timer !== undefined) clearInterval(timer);
        reject(error);
      }
    };
    check();
    if (!settled) timer = setInterval(check, 50);
  });
}

function boundedNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-100_000, Math.min(100_000, number));
}
