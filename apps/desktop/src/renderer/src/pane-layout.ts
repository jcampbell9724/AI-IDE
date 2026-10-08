import type { BrowserBounds } from "../../shared/contracts";

export const DEFAULT_CHAT_PANE_PERCENT = 100 / 3;
export const MIN_CHAT_PANE_PIXELS = 360;
export const MIN_BROWSER_PANE_PIXELS = 360;
export const PANE_RESIZER_PIXELS = 7;
export const COMPACT_WORKSPACE_PIXELS = 820;
export const OVERLAY_SIDEBAR_PIXELS = 1100;

interface RectEdges {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export function browserBoundsFromRect(
  rect: RectEdges,
  viewportWidth: number,
  viewportHeight: number,
  requestedVisible: boolean,
): BrowserBounds {
  const maxWidth = Math.max(0, Math.round(viewportWidth));
  const maxHeight = Math.max(0, Math.round(viewportHeight));
  const x = clamp(Math.round(rect.left), 0, maxWidth);
  const y = clamp(Math.round(rect.top), 0, maxHeight);
  const right = clamp(Math.round(rect.right), x, maxWidth);
  const bottom = clamp(Math.round(rect.bottom), y, maxHeight);
  const width = Math.max(0, right - x);
  const height = Math.max(0, bottom - y);

  return {
    x,
    y,
    width,
    height,
    visible: requestedVisible && width > 0 && height > 0,
  };
}

export function chatPanePercentFromPointer(pointerX: number, workspaceLeft: number, workspaceWidth: number): number {
  if (!Number.isFinite(workspaceWidth) || workspaceWidth <= PANE_RESIZER_PIXELS) {
    return DEFAULT_CHAT_PANE_PERCENT;
  }

  const availableWidth = workspaceWidth - PANE_RESIZER_PIXELS;
  // Chat is on the right. Moving the divider left makes chat wider.
  const requestedPixels = workspaceLeft + workspaceWidth - pointerX - PANE_RESIZER_PIXELS / 2;
  const minimumChat = Math.min(Math.max(MIN_CHAT_PANE_PIXELS, workspaceWidth * 0.2), availableWidth * 0.55);
  const maximumChat = Math.max(minimumChat, Math.min(workspaceWidth * 0.7, availableWidth - Math.min(MIN_BROWSER_PANE_PIXELS, availableWidth * 0.55)));
  return (clamp(requestedPixels, minimumChat, maximumChat) / workspaceWidth) * 100;
}

export function chatPanePercentForWidth(percent: number, workspaceWidth: number): number {
  if (!Number.isFinite(workspaceWidth) || workspaceWidth <= PANE_RESIZER_PIXELS) return DEFAULT_CHAT_PANE_PERCENT;
  return chatPanePercentFromPointer(
    workspaceWidth - workspaceWidth * clampStoredChatPanePercent(percent) / 100 - PANE_RESIZER_PIXELS / 2,
    0,
    workspaceWidth,
  );
}

export function clampStoredChatPanePercent(value: number): number {
  return Number.isFinite(value) ? clamp(value, 20, 70) : DEFAULT_CHAT_PANE_PERCENT;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
