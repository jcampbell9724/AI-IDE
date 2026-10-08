import { describe, expect, it } from "vitest";
import {
  browserBoundsFromRect,
  chatPanePercentFromPointer,
  chatPanePercentForWidth,
  clampStoredChatPanePercent,
  DEFAULT_CHAT_PANE_PERCENT,
  MIN_BROWSER_PANE_PIXELS,
  MIN_CHAT_PANE_PIXELS,
  PANE_RESIZER_PIXELS,
} from "./pane-layout";

describe("browser viewport bounds", () => {
  it("rounds a visible viewport into native browser coordinates", () => {
    expect(browserBoundsFromRect(
      { left: 401.4, top: 52.6, right: 1200.8, bottom: 800.2 },
      1400,
      900,
      true,
    )).toEqual({ x: 401, y: 53, width: 800, height: 747, visible: true });
  });

  it("clips bounds to the renderer viewport", () => {
    expect(browserBoundsFromRect(
      { left: -25, top: -10, right: 1500, bottom: 950 },
      1200,
      800,
      true,
    )).toEqual({ x: 0, y: 0, width: 1200, height: 800, visible: true });
  });

  it("does not expose a zero-area or unrequested browser view", () => {
    expect(browserBoundsFromRect(
      { left: 1300, top: 100, right: 1400, bottom: 200 },
      1200,
      800,
      true,
    )).toEqual({ x: 1200, y: 100, width: 0, height: 100, visible: false });

    expect(browserBoundsFromRect(
      { left: 400, top: 50, right: 1200, bottom: 800 },
      1400,
      900,
      false,
    ).visible).toBe(false);
  });
});

describe("chat pane sizing", () => {
  it("defaults to one third and clamps persisted values", () => {
    expect(DEFAULT_CHAT_PANE_PERCENT).toBeCloseTo(33.333333, 5);
    expect(clampStoredChatPanePercent(10)).toBe(20);
    expect(clampStoredChatPanePercent(80)).toBe(70);
    expect(clampStoredChatPanePercent(Number.NaN)).toBe(DEFAULT_CHAT_PANE_PERCENT);
  });

  it("keeps both panes usable while dragging", () => {
    const workspaceWidth = 1200;
    const availableWidth = workspaceWidth - PANE_RESIZER_PIXELS;

    expect(chatPanePercentFromPointer(5000, 0, workspaceWidth))
      .toBeCloseTo((MIN_CHAT_PANE_PIXELS / workspaceWidth) * 100);
    expect(chatPanePercentFromPointer(-1000, 0, workspaceWidth))
      .toBeCloseTo(((availableWidth - MIN_BROWSER_PANE_PIXELS) / workspaceWidth) * 100);
  });

  it("keeps restored and keyboard sizes usable after navigation expands", () => {
    for (const width of [773, 840, 1128, 1340, 1800]) {
      for (const preferred of [20, 33.333333, 50, 70]) {
        const chat = width * chatPanePercentForWidth(preferred, width) / 100;
        expect(chat).toBeGreaterThanOrEqual(MIN_CHAT_PANE_PIXELS - 0.001);
        expect(width - PANE_RESIZER_PIXELS - chat).toBeGreaterThanOrEqual(MIN_BROWSER_PANE_PIXELS - 0.001);
      }
    }
  });

  it("measures right-hand chat independently of the sidebar offset", () => {
    const width = 1128;
    const left = 260;
    const pointer = left + width - 420 - PANE_RESIZER_PIXELS / 2;
    expect(chatPanePercentFromPointer(pointer, left, width) * width / 100).toBeCloseTo(420);
    expect(chatPanePercentFromPointer(pointer - 50, left, width)).toBeGreaterThan(chatPanePercentFromPointer(pointer, left, width));
  });

  it("falls back safely when the workspace cannot be measured", () => {
    expect(chatPanePercentFromPointer(100, 0, 0)).toBe(DEFAULT_CHAT_PANE_PERCENT);
    expect(chatPanePercentFromPointer(100, 0, Number.NaN)).toBe(DEFAULT_CHAT_PANE_PERCENT);
  });
});
