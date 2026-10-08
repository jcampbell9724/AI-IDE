import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { DesktopBrowserState } from "../../shared/contracts";

// Exercise the real event handler without adding a DOM runtime to the Node tests.
const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handlerSource = "";
function findHandler(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "runBrowserAction") {
    handlerSource = node.getText(parsed);
  } else {
    ts.forEachChild(node, findHandler);
  }
}
findHandler(parsed);
if (!handlerSource) throw new Error("Browser toolbar action handler was not found.");
const handlerJavaScript = ts.transpileModule(handlerSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

type BrowserAction = "back" | "forward" | "reload";
const healthyBrowser: DesktopBrowserState = {
  url: "http://localhost:3000/", title: "Preview", loading: false, canGoBack: true, canGoForward: true, visible: true,
};

function recoveryHarness(browserAction: (action: BrowserAction) => Promise<DesktopBrowserState>) {
  let previewError = "The previous Open request failed.";
  let snapshot = { browser: { ...healthyBrowser, error: "ERR_CONNECTION_REFUSED" } as DesktopBrowserState };
  const showError = vi.fn();
  const runAction = runInNewContext(`${handlerJavaScript}\nrunBrowserAction;`, {
    window: { browserAgent: { browserAction } },
    setSnapshot: (update: (current: typeof snapshot) => typeof snapshot) => { snapshot = update(snapshot); },
    setPreviewActionError: (error: string) => { previewError = error; },
    showError,
  }) as (action: BrowserAction) => Promise<void>;
  return { runAction, showError, previewError: () => previewError, browser: () => snapshot.browser };
}

describe("browser toolbar preview recovery", () => {
  it.each(["back", "forward", "reload"] as const)("clears a stale Open failure after successful %s", async (action) => {
    const browserAction = vi.fn().mockResolvedValue(healthyBrowser);
    const harness = recoveryHarness(browserAction);

    await harness.runAction(action);

    expect(browserAction).toHaveBeenCalledWith(action);
    expect(harness.browser()).toEqual(healthyBrowser);
    expect(harness.previewError()).toBe("");
    expect(harness.showError).not.toHaveBeenCalled();
  });

  it("retains the failure overlay while recovery is pending and when it rejects", async () => {
    let rejectAction!: (reason: Error) => void;
    const browserAction = vi.fn(() => new Promise<DesktopBrowserState>((_resolve, reject) => { rejectAction = reject; }));
    const harness = recoveryHarness(browserAction);
    const attempt = harness.runAction("reload");

    expect(harness.previewError()).toBe("The previous Open request failed.");
    const failure = new Error("Preview is still unavailable.");
    rejectAction(failure);
    await attempt;

    expect(harness.previewError()).toBe("The previous Open request failed.");
    expect(harness.browser().error).toBe("ERR_CONNECTION_REFUSED");
    expect(harness.showError).toHaveBeenCalledWith(failure);
  });

  it("preserves failure feedback when navigation returns an error state", async () => {
    const failedBrowser = { ...healthyBrowser, error: "Navigation outside localhost was blocked." };
    const harness = recoveryHarness(vi.fn().mockResolvedValue(failedBrowser));

    await harness.runAction("back");

    expect(harness.browser()).toEqual(failedBrowser);
    expect(harness.previewError()).toBe("The previous Open request failed.");
  });
});
