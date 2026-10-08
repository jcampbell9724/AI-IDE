import { WebContentsView, type Rectangle } from "electron";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserAction } from "@browser-agent/shared";
import { buildRobustSelector } from "@browser-agent/shared/browser-selector";
import type { BrowserBounds, DesktopBrowserState } from "../shared/contracts";
import { loopbackUrl } from "./browser-url";

import { elementPickerScript } from "./element-picker";

const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ERRORS = 100;
const ROBUST_SELECTOR_SOURCE = buildRobustSelector.toString();

function abortable<T>(operation: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
      onAbort?.();
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(signal.aborted ? signal.reason : error);
      },
    );
    if (signal.aborted) abort();
  });
}

function textArgument(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function tabIdArgument(input: Record<string, unknown>): number | undefined {
  const value = input.tabId;
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error("tabId must be a non-negative integer.");
  return Number(value);
}

export class DesktopBrowser {
  readonly view: WebContentsView;
  private visible = false;
  private error: string | undefined;
  private readonly consoleEntries: Array<Record<string, unknown>> = [];
  private readonly networkErrors: Array<Record<string, unknown>> = [];

  constructor(private readonly onStateChange: (state: DesktopBrowserState) => void) {
    this.view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: "persist:browser-agent-project",
      },
    });
    this.view.setVisible(false);
    this.view.setBackgroundColor("#ffffff");

    const contents = this.view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    const guardNavigation = (event: { preventDefault(): void }, url: string): void => {
      try {
        loopbackUrl(url);
      } catch {
        event.preventDefault();
        this.error = "Navigation outside localhost was blocked.";
        this.emitState();
      }
    };
    contents.on("will-navigate", guardNavigation);
    contents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) guardNavigation(event, url);
    });
    contents.on("did-start-loading", () => this.emitState());
    contents.on("did-finish-load", () => {
      this.error = undefined;
      this.emitState();
    });
    contents.on("did-stop-loading", () => this.emitState());
    contents.on("page-title-updated", () => this.emitState());
    contents.on("did-navigate", () => this.emitState());
    contents.on("did-navigate-in-page", () => this.emitState());
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      const item = { code, description, url, timestamp: new Date().toISOString() };
      this.networkErrors.push(item);
      if (this.networkErrors.length > MAX_NETWORK_ERRORS) this.networkErrors.shift();
      if (isMainFrame && code !== -3) this.error = description;
      this.emitState();
    });
    contents.on("console-message", (details) => {
      this.consoleEntries.push({
        level: details.level,
        message: details.message.slice(0, 20_000),
        lineNumber: details.lineNumber,
        sourceId: details.sourceId,
        timestamp: new Date().toISOString(),
      });
      if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) this.consoleEntries.shift();
    });
  }

  async pickElement(): Promise<unknown> {
    this.assertCurrentUrl();
    this.view.webContents.focus();
    return this.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: elementPickerScript() }]);
  }

  async cancelElementPicker(): Promise<void> {
    await this.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: "globalThis.__spanCancelPicker?.()" }]);
  }

  state(): DesktopBrowserState {
    const history = this.view.webContents.navigationHistory;
    return {
      url: this.view.webContents.getURL() === "about:blank" ? "" : this.view.webContents.getURL(),
      title: this.view.webContents.getTitle(),
      loading: this.view.webContents.isLoading(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      visible: this.visible,
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  setBounds(input: BrowserBounds, contentBounds: Rectangle): void {
    const x = Math.max(0, Math.min(Math.floor(input.x), contentBounds.width));
    const y = Math.max(0, Math.min(Math.floor(input.y), contentBounds.height));
    const width = Math.max(0, Math.min(Math.floor(input.width), contentBounds.width - x));
    const height = Math.max(0, Math.min(Math.floor(input.height), contentBounds.height - y));
    const visible = input.visible && width > 0 && height > 0;
    const visibilityChanged = visible !== this.visible;
    this.visible = visible;
    this.view.setBounds({ x, y, width, height });
    this.view.setVisible(this.visible);
    if (visibilityChanged && !visible) void this.cancelElementPicker().catch(() => undefined);
    if (visibilityChanged) this.emitState();
  }

  async navigate(value: string, signal?: AbortSignal): Promise<DesktopBrowserState> {
    const url = loopbackUrl(value);
    signal?.throwIfAborted();
    this.error = undefined;
    const stop = (): void => { if (!this.view.webContents.isDestroyed()) this.view.webContents.stop(); };
    await abortable(this.view.webContents.loadURL(url.toString()), signal, stop);
    signal?.throwIfAborted();
    return this.state();
  }

  async reset(): Promise<void> {
    this.view.webContents.stop();
    await this.view.webContents.loadURL("about:blank");
    this.view.webContents.navigationHistory.clear();
    this.consoleEntries.length = 0;
    this.networkErrors.length = 0;
    this.error = undefined;
    this.emitState();
  }

  async simpleAction(action: "back" | "forward" | "reload", signal?: AbortSignal): Promise<DesktopBrowserState> {
    signal?.throwIfAborted();
    this.assertCurrentUrl();
    const history = this.view.webContents.navigationHistory;
    this.error = undefined;
    if (action === "back" && history.canGoBack()) {
      await this.waitForNavigation(() => history.goBack(), signal);
    }
    if (action === "forward" && history.canGoForward()) {
      await this.waitForNavigation(() => history.goForward(), signal);
    }
    if (action === "reload") {
      await this.waitForNavigation(() => this.view.webContents.reload(), signal);
    }
    return this.state();
  }

  async execute(action: BrowserAction, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (action !== "navigate") this.assertCurrentUrl();
    const requestedTabId = tabIdArgument(args);
    if (requestedTabId !== undefined && requestedTabId !== this.view.webContents.id) {
      throw new Error("The requested browser tab is no longer available in the desktop browser.");
    }
    switch (action) {
      case "context":
        return { tab: this.tab(), elements: await abortable(this.captureElements(), signal) };
      case "inspect_element":
        return abortable(this.captureElements(textArgument(args, "selector")), signal);
      case "navigate": {
        const url = textArgument(args, "url");
        if (!url) throw new Error("Browser navigation requires a URL.");
        return this.navigate(url, signal);
      }
      case "back":
      case "forward":
        return this.simpleAction(action, signal);
      case "refresh":
        return this.simpleAction("reload", signal);
      case "tabs":
        return [this.tab()];
      case "screenshot": {
        const image = await abortable(this.view.webContents.capturePage(), signal);
        const size = image.getSize();
        const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
        const bounded = scale < 1 ? image.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
        }) : image;
        return { dataUrl: `data:image/jpeg;base64,${bounded.toJPEG(85).toString("base64")}`, tab: this.tab() };
      }
      case "console":
        return { entries: [...this.consoleEntries] };
      case "network_errors":
        return { entries: [...this.networkErrors] };
      case "click":
      case "type":
      case "hover":
      case "focus":
        return this.whenPageReady(() => this.elementInteraction(action, args), signal);
      case "wait_for":
        return this.waitFor(args, signal);
      case "scroll":
        return this.whenPageReady(() => this.scroll(args), signal);
      case "key":
        return this.whenPageReady(() => this.key(args), signal);
    }
  }

  private assertCurrentUrl(): void {
    const url = this.view.webContents.getURL();
    if (url && url !== "about:blank") loopbackUrl(url);
  }

  destroy(): void {
    this.view.webContents.close();
  }

  private tab(): Record<string, unknown> {
    return { id: this.view.webContents.id, ...this.state() };
  }

  private emitState(): void {
    this.onStateChange(this.state());
  }

  private async whenPageReady(action: () => unknown, signal?: AbortSignal): Promise<unknown> {
    const contents = this.view.webContents;
    signal?.throwIfAborted();
    // Electron queues executeJavaScript during loading. Wait here instead so a
    // cancelled input is never left queued to modify the page when it finishes.
    while (!contents.isDestroyed() && contents.isLoading()) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          contents.removeListener("did-stop-loading", ready);
          contents.removeListener("destroyed", destroyed);
          signal?.removeEventListener("abort", abort);
        };
        const ready = (): void => { cleanup(); resolve(); };
        const destroyed = (): void => { cleanup(); reject(new Error("The desktop browser was closed.")); };
        const abort = (): void => { cleanup(); reject(signal?.reason); };
        contents.once("did-stop-loading", ready);
        contents.once("destroyed", destroyed);
        signal?.addEventListener("abort", abort, { once: true });
      });
      signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    if (contents.isDestroyed()) throw new Error("The desktop browser was closed.");
    this.assertCurrentUrl();
    return abortable(Promise.resolve(action()), signal);
  }

  private waitForNavigation(start: () => void, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const contents = this.view.webContents;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        contents.removeListener("did-finish-load", finished);
        contents.removeListener("did-navigate-in-page", navigatedInPage);
        contents.removeListener("did-fail-load", failed);
        signal?.removeEventListener("abort", abort);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const finished = (): void => succeed();
      const navigatedInPage = (): void => succeed();
      const abort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal?.reason);
        if (!contents.isDestroyed()) contents.stop();
      };
      const failed = (
        _event: Electron.Event,
        code: number,
        description: string,
        _url: string,
        isMainFrame: boolean,
      ): void => {
        if (!isMainFrame || code === -3 || settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Browser navigation failed: ${description}`));
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Browser navigation did not finish in time."));
        if (!contents.isDestroyed()) contents.stop();
      }, 30_000);
      timeout.unref();
      contents.once("did-finish-load", finished);
      contents.once("did-navigate-in-page", navigatedInPage);
      contents.on("did-fail-load", failed);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        start();
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
  }

  private captureElements(selector?: string): Promise<unknown> {
    const selectorJson = JSON.stringify(selector ?? "");
    return this.view.webContents.executeJavaScript(`(() => {
      const requested = ${selectorJson};
      const buildRobustSelector = (${ROBUST_SELECTOR_SOURCE});
      let candidates;
      if (requested) {
        try {
          candidates = Array.from(document.querySelectorAll(requested)).slice(0, 120);
        } catch {
          throw new Error('Invalid inspection selector: ' + requested);
        }
        if (!candidates.length) throw new Error('No page elements match the inspection selector: ' + requested);
      } else {
        const selector = [
          'h1', 'h2', 'h3', 'button', 'a[href]', 'input:not([type="hidden"])', 'textarea', 'select',
          'summary', '[role]', '[data-testid]', '[data-test]', '[data-qa]', '[data-cy]',
          '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
        ].join(',');
        candidates = Array.from(document.querySelectorAll(selector))
          .filter((element) => !element.closest('[data-browser-agent-temporary]'))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          })
          .slice(0, 120);
      }
      const text = (value, limit) => String(value || '').trim().replace(/\\s+/g, ' ').slice(0, limit);
      const accessibleName = (element) => {
        const aria = element.getAttribute('aria-label');
        if (aria) return text(aria, 500);
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          const label = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
          if (label.trim()) return text(label, 500);
        }
        if (element.labels?.length) return text(Array.from(element.labels).map((label) => label.textContent || '').join(' '), 500);
        return text(element.getAttribute('title') || element.getAttribute('alt') || element.innerText || element.textContent, 500);
      };
      const describe = (element) => {
        const rect = element.getBoundingClientRect();
        const attributes = {};
        for (const item of Array.from(element.attributes || []).slice(0, 50)) {
          if (/^(value|nonce|srcdoc)$/i.test(item.name) || /^on/i.test(item.name)) continue;
          attributes[item.name] = String(item.value).slice(0, 500);
        }
        const isPassword = element instanceof HTMLInputElement && element.type === 'password';
        const style = getComputedStyle(element);
        const selector = buildRobustSelector(element, document);
        return {
          selector,
          selectorIsUnique: document.querySelectorAll(selector).length === 1,
          tagName: element.tagName.toLowerCase(),
          role: element.getAttribute('role'),
          accessibleName: isPassword ? '' : accessibleName(element),
          text: isPassword ? '' : text(element.innerText || element.textContent, 1000),
          attributes,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
          disabled: 'disabled' in element ? Boolean(element.disabled) : undefined,
          checked: 'checked' in element ? Boolean(element.checked) : undefined,
          value: !isPassword && 'value' in element ? text(element.value, 500) : undefined,
          outerHTMLSnippet: isPassword
            ? String(element.cloneNode(false).outerHTML || '').replace(/\\svalue=(?:"[^"]*"|'[^']*'|[^\\s>]+)/gi, '').slice(0, 4000)
            : String(element.outerHTML || '').slice(0, 4000),
        };
      };
      return candidates.map(describe);
    })()`, true);
  }

  private elementInteraction(action: "click" | "type" | "hover" | "focus", args: Record<string, unknown>): Promise<unknown> {
    const selector = textArgument(args, "selector");
    if (!selector) throw new Error(`Browser ${action} requires a selector.`);
    const value = textArgument(args, "text", "value") ?? "";
    return this.view.webContents.executeJavaScript(`(() => {
      const selector = ${JSON.stringify(selector)};
      let matches;
      try {
        matches = document.querySelectorAll(selector);
      } catch {
        throw new Error('Invalid interaction selector: ' + selector);
      }
      if (!matches.length) throw new Error('Element was not found: ' + selector);
      if (matches.length > 1) throw new Error('Interaction selector matched ' + matches.length + ' elements; inspect the page and use a unique selector.');
      const element = matches[0];
      const action = ${JSON.stringify(action)};
      if (!element.isConnected) throw new Error('The selected element is no longer attached to the page.');
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
        throw new Error('The selected element is not visible.');
      }
      if ('disabled' in element && Boolean(element.disabled)) throw new Error('The selected element is disabled.');
      element.scrollIntoView({ block: 'center', inline: 'center' });
      if (action === 'click') {
        if (typeof element.click !== 'function') throw new Error('The selected element cannot be clicked.');
        element.click();
      }
      if (action === 'focus') {
        if (typeof element.focus !== 'function') throw new Error('The selected element cannot be focused.');
        element.focus();
      }
      if (action === 'hover') {
        element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        element.dispatchEvent(new MouseEvent('mouseenter'));
      }
      if (action === 'type') {
        if (typeof element.focus === 'function') element.focus();
        const value = ${JSON.stringify(value)};
        if (element instanceof HTMLInputElement) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
        } else if (element instanceof HTMLTextAreaElement) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, value);
        } else if (element instanceof HTMLSelectElement) {
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value);
        } else if (element instanceof HTMLElement && element.isContentEditable) {
          element.textContent = value;
        } else {
          throw new Error('The selected element is not editable.');
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { action, selector, applied: true };
    })()`, true);
  }

  private scroll(args: Record<string, unknown>): Promise<unknown> {
    const selector = textArgument(args, "selector");
    const x = typeof args.x === "number" ? args.x : typeof args.deltaX === "number" ? args.deltaX : 0;
    const y = typeof args.y === "number" ? args.y : typeof args.deltaY === "number" ? args.deltaY : 500;
    return this.view.webContents.executeJavaScript(`(() => {
      const selector = ${JSON.stringify(selector ?? "")};
      if (selector) {
        let matches;
        try {
          matches = document.querySelectorAll(selector);
        } catch {
          throw new Error('Invalid scroll selector: ' + selector);
        }
        if (!matches.length) throw new Error('Element was not found: ' + selector);
        if (matches.length > 1) throw new Error('Scroll selector matched ' + matches.length + ' elements; use a unique selector.');
        matches[0].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        return { selector, scrolled: true };
      }
      window.scrollBy({ left: ${JSON.stringify(x)}, top: ${JSON.stringify(y)}, behavior: 'smooth' });
      return { x: window.scrollX, y: window.scrollY };
    })()`, true);
  }

  private async waitFor(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const selector = textArgument(args, "selector");
    if (!selector) throw new Error("Browser wait_for requires a selector.");
    const requestedTimeout = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
      ? args.timeoutMs
      : 5_000;
    const timeoutMs = Math.max(100, Math.min(15_000, Math.floor(requestedTimeout)));
    const state = textArgument(args, "state") ?? "visible";
    if (!["attached", "visible", "hidden", "detached"].includes(state)) {
      throw new Error("wait_for state must be attached, visible, hidden, or detached.");
    }
    const inspect = `(() => {
      const selector = ${JSON.stringify(selector)};
      const state = ${JSON.stringify(state)};
      let elements;
      try {
        elements = Array.from(document.querySelectorAll(selector));
      } catch {
        throw new Error('Invalid wait_for selector: ' + selector);
      }
      const visible = elements.some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
      return {
        ready: state === 'attached'
          ? elements.length > 0
          : state === 'visible'
            ? visible
            : state === 'hidden'
              ? !visible
              : elements.length === 0,
        matches: elements.length,
      };
    })()`;
    // Keep polling in the host so cancellation never leaves a page interval running.
    const startedAt = Date.now();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`Timed out waiting for ${selector} to become ${state}.`)), timeoutMs);
    const boundedSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      while (true) {
        boundedSignal.throwIfAborted();
        this.assertCurrentUrl();
        const result = await abortable<{ ready: boolean; matches: number }>(
          this.view.webContents.executeJavaScript(inspect, true), boundedSignal,
        );
        if (result.ready) return { selector, state, matches: result.matches, elapsedMs: Date.now() - startedAt };
        await delay(50, undefined, { signal: boundedSignal });
      }
    } catch (error) {
      boundedSignal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private key(args: Record<string, unknown>): Record<string, unknown> {
    const key = textArgument(args, "key");
    if (!key) throw new Error("Browser key action requires a key.");
    this.view.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
    if (key.length === 1) this.view.webContents.sendInputEvent({ type: "char", keyCode: key });
    this.view.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
    return { key, sent: true };
  }
}
