import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const renderer = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
const projectSidebar = await readFile(new URL("./project-sidebar.tsx", import.meta.url), "utf8");
const contracts = await readFile(new URL("../../shared/contracts.ts", import.meta.url), "utf8");
const preload = await readFile(new URL("../../preload/index.ts", import.meta.url), "utf8");
const main = await readFile(new URL("../../main/index.ts", import.meta.url), "utf8");

describe("desktop create-project flow", () => {
  it("exposes project creation through the trusted desktop bridge", () => {
    expect(contracts).toContain("export interface CreateProjectInput");
    expect(contracts).toMatch(/createProject\(input: CreateProjectInput\): Promise<DesktopProject>/);
    expect(preload).toContain('createProject: (input: CreateProjectInput) => ipcRenderer.invoke("desktop:create-project", input)');
    expect(main).toContain('ipcMain.handle("desktop:create-project"');
  });

  it("asks for a parent folder, creates a named child, and selects it", () => {
    const handlerStart = main.indexOf('ipcMain.handle("desktop:create-project"');
    const handlerEnd = main.indexOf('ipcMain.handle("desktop:select-project"', handlerStart);
    const handler = main.slice(handlerStart, handlerEnd);

    expect(handler).toContain("dialog.showOpenDialog");
    expect(handler).toContain('properties: ["openDirectory"]');
    expect(handler).toContain("createProjectDirectory(");
    expect(handler).toContain("selectProject(");
  });

  it("connects the project sidepane to the create-project bridge", () => {
    expect(projectSidebar).toContain("Create new project");
    expect(renderer).toMatch(/window\.browserAgent\.createProject\(\{\s*name\s*}\)/);
    expect(renderer).toContain("onCreateProject");
    expect(projectSidebar).toContain("readonly onCreateProject: (name: string) => void");
    expect(projectSidebar).toMatch(/props\.onCreateProject\(newProjectName(?:\.trim\(\))?\)/);
  });
});
