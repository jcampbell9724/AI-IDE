import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

describe("desktop split workspace", () => {
  it("renders navigation, central preview, and right-hand chat", () => {
    expect(source).toContain('className={`desktop-workspace ');
    expect(source).toContain('className={`workspace-panes ');
    expect(source.indexOf('id="workspace-preview"')).toBeLessThan(source.indexOf('id="workspace-chat"'));
    expect(source).toContain('className="history-sidebar workspace-sidebar"');
    expect(source).toContain('className="chatbox"');
    expect(source).toContain('className="new-chat-button sidebar-new-chat"');
    expect(source).toContain('className="pane-resizer"');
    expect(source).toContain('className={`browser-pane ');
    expect(source).toContain('className={`browser-viewport ');
  });

  it("uses concise heading-three copy for the empty chat and browser states", () => {
    expect(source).toContain("<h3>{emptyStatePhrase}</h3>");
    expect(source).toContain("Your preview appears here");
    expect(source).not.toContain("Your running project will appear here automatically.");
  });

  it("exposes an accessible vertical separator for resizing the chat pane", () => {
    expect(source).toContain('role="separator"');
    expect(source).toContain('aria-orientation="vertical"');
    expect(source).toContain("aria-valuenow={Math.round(visibleChatPercent)}");
    expect(source).toContain("--chat-pane-percent");
    expect(source).toContain("onPointerDown={beginPaneResize}");
    expect(source).toContain("onPointerMove={resizePane}");
    expect(source).toContain("onKeyDown={resizePaneWithKeyboard}");
  });

  it("keeps the native browser view aligned to the visible viewport", () => {
    expect(source).toContain("browserViewportRef");
    expect(source).toContain("ResizeObserver");
    expect(source).toContain("getBoundingClientRect()");
    expect(source).toContain("browserBoundsFromRect");
    expect(source).toContain("browserRequestedVisibleRef.current");
    expect(source).toContain("setBrowserBounds");
    expect(source).toContain("setBrowserBounds(bounds)");
  });

  it("keeps navigation independently collapsible", () => {
    expect(source).toContain('aria-controls="sidebar-panel"');
    expect(source).toContain("aria-expanded={historyOpen}");
    expect(source).toContain("history-open");
    expect(source).toContain("history-collapsed");
  });

  it("shows only the hamburger in the collapsed rail and keeps labeled navigation inside", () => {
    expect(source).toContain("const [historyOpen, setHistoryOpen] = useState(false)");
    const rail = source.slice(source.indexOf('className="activity-rail"'), source.indexOf('{historyOpen && <div id="sidebar-panel"'));
    expect(rail.match(/<button\b/g)).toHaveLength(1);
    expect(rail.match(/<UiIcon\b/g)).toHaveLength(1);
    expect(rail).toContain('<UiIcon name="menu" />');
    expect(rail).toContain('aria-controls="sidebar-panel"');
    expect(rail).not.toContain('<img');
    expect(source).toContain('className="labeled-navigation" aria-label="Main navigation"');
    const navigation = source.slice(source.indexOf('<nav className="labeled-navigation"'), source.indexOf('</nav>', source.indexOf('<nav className="labeled-navigation"')));
    expect(navigation).toContain('["projects", "chats", "files"] as const');
    expect(navigation).not.toContain('"models"');
    expect(source).toContain('id="settings-tab-model"');
    expect(source).toContain('<UiIcon name={tab} />');
    expect(source).toContain('<UiIcon name="settings" /><span>Settings</span>');
  });

  it("provides the full model picker in the workspace sidebar", () => {
    expect(source).toContain('id="model-sidebar"');
    expect(source).toContain('id="sidebar-model-search"');
    expect(source).toContain('aria-label="Available sidebar models"');
    expect(source).toContain("onSelect={(model) => void saveSelectedModel(model)}");
    expect(source).toContain("onRefresh={() => void loadAvailableModels(true)}");
  });

  it("opens project files in closable tabs without exposing the native browser underneath", () => {
    expect(source).toContain("readProjectFile(path)");
    expect(source).toContain("const [codeViews, setCodeViews]");
    expect(source).toContain("function closeProjectFile(path: string)");
    expect(source).toContain('className="code-tab-close"');
    expect(source).toContain("activeCodePath !== null");
    expect(source).toContain("activeCodeView && <CodeViewer");
  });

  it("places the workspace tabs in their own row above the location toolbar", () => {
    const tabbarIndex = source.indexOf('className="workspace-tabbar"');
    const toolbarIndex = source.indexOf('className="browser-toolbar"');
    expect(tabbarIndex).toBeGreaterThan(-1);
    expect(toolbarIndex).toBeGreaterThan(tabbarIndex);
  });

  it("keeps New chat inside the conversation history panel", () => {
    const historyIndex = source.indexOf('id="conversation-history-list"');
    const newChatIndex = source.indexOf('className="new-chat-button sidebar-new-chat"');
    expect(newChatIndex).toBeGreaterThan(historyIndex);
  });

  it("always rotates the conversation when New chat is pressed", () => {
    expect(source).toContain("setChatHistory((current) => createChat(current))");
  });

  it("coalesces streamed text updates to the display frame", () => {
    expect(source).toContain("pendingAssistantDeltaRef.current += event.delta");
    expect(source).toContain("assistantStreamFrameRef.current = window.requestAnimationFrame");
    expect(source).toContain("flushPendingAssistantText");
  });

  it("lets readers stay in place and return to the latest message", () => {
    expect(source).toContain("shouldFollowChat.current = nearBottom");
    expect(source).toContain("showScrollToLatest");
    expect(source).toContain('aria-label="Scroll to latest message"');
  });

  it("updates the split pane directly while dragging", () => {
    expect(source).toContain('style.setProperty("--chat-pane-percent"');
    expect(source).toContain("setChatPanePercent(paneResizeValueRef.current)");
  });
});
