import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const main = await readFile(new URL("./index.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../renderer/src/App.tsx", import.meta.url), "utf8");

describe("desktop startup state", () => {
  it("offers project resumption while restoring the saved model", () => {
    expect(main).toContain('let activeModel = ""');
    expect(main).toContain("selectedModel: activeModel");
    expect(main).toContain("await runtime.projects.clearCurrent()");
    expect(main).toContain("activeModel = stored.selectedModel");
    expect(main).not.toContain('settings.update({ selectedModel: "" })');
    expect(app).toContain("Resume project");
    expect(app).toContain("Open another project");
  });

  it("starts with no open chat and loads history only after a project is selected", () => {
    expect(app).toContain("useState<PersistedChatHistory>(() => createEmptyChatHistory())");
    expect(app).toContain("loadProjectChatHistory(projectPath)");
    expect(app).toContain("saveProjectChatHistory(chatProjectPathRef.current, chatHistoryRef.current)");
    expect(app).toContain("missingSetup === null && <div className=\"empty-state\"");
  });
});
