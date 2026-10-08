import { describe, expect, it } from "vitest";
import type { StorageLike } from "./persist";
import { emptyWorkspaceView, loadWorkspaceView, normalizeWorkspaceView, saveWorkspaceView } from "./workspace-memory";

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("workspace restoration", () => {
  it("restores tabs, the selected file, reading positions and sidebar per project", () => {
    const store = memoryStorage();
    const view = { ...emptyWorkspaceView(), files: ["README.md", "src/main.ts"], activeFile: "src/main.ts", sidebar: "files" as const, sidebarOpen: true, chatScroll: { chat1: 842 }, fileScroll: { "src/main.ts": 1250 } };
    saveWorkspaceView("C:\\work\\alpha", view, store);
    saveWorkspaceView("C:/work/beta", { ...emptyWorkspaceView(), files: ["index.html"] }, store);
    expect(loadWorkspaceView("C:/work/alpha", store)).toEqual(view);
    expect(loadWorkspaceView("C:/work/beta", store).files).toEqual(["index.html"]);
    expect(loadWorkspaceView("C:/work/beta", store).chatScroll).toEqual({});
  });

  it("handles corrupt data and unavailable storage without blocking startup", () => {
    const invalid = { ...memoryStorage(), getItem: () => "not JSON" };
    expect(loadWorkspaceView("project", invalid)).toEqual(emptyWorkspaceView());
    const unavailable = { ...memoryStorage(), getItem: () => { throw new Error("Denied"); }, setItem: () => { throw new Error("Full"); } };
    expect(loadWorkspaceView("project", unavailable)).toEqual(emptyWorkspaceView());
    expect(() => saveWorkspaceView("project", emptyWorkspaceView(), unavailable)).not.toThrow();
  });

  it("does not restore outside paths or invalid reading positions", () => {
    const result = normalizeWorkspaceView({
      files: ["../secret", "/absolute", "C:\\secret", "src/main.ts", "src/main.ts"],
      activeFile: "../secret", sidebar: "unknown", sidebarOpen: "yes",
      chatScroll: { valid: 30, negative: -1, infinite: Infinity, text: "20" },
    });
    expect(result.files).toEqual(["src/main.ts"]);
    expect(result.activeFile).toBeNull();
    expect(result.sidebar).toBe("chats");
    expect(result.sidebarOpen).toBe(false);
    expect(result.chatScroll).toEqual({ valid: 30 });
  });

  it("bounds restored tab counts and preserves selecting Preview", () => {
    const files = Array.from({ length: 40 }, (_, index) => `file-${index}.ts`);
    const view = normalizeWorkspaceView({ files, activeFile: null });
    expect(view.files).toHaveLength(20);
    expect(view.activeFile).toBeNull();
  });
});
