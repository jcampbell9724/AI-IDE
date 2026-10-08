import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const mainSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");
const preloadSource = await readFile(new URL("../preload/index.ts", import.meta.url), "utf8");
const projectFileSource = await readFile(new URL("./project-files.ts", import.meta.url), "utf8");
const contractsSource = await readFile(new URL("../shared/contracts.ts", import.meta.url), "utf8");

describe("desktop project browser bridge", () => {
  it("exposes typed list, read, and save operations through the isolated preload", () => {
    expect(contractsSource).toContain("listProjectDirectory(): Promise<DesktopProjectDirectory>");
    expect(contractsSource).toContain("readProjectFile(path: string): Promise<DesktopProjectFile>");
    expect(preloadSource).toContain('ipcRenderer.invoke("desktop:list-project-directory")');
    expect(preloadSource).toContain('ipcRenderer.invoke("desktop:read-project-file", path)');
    expect(contractsSource).toContain("saveProjectFile(input: SaveProjectFileInput): Promise<DesktopProjectFile>");
    expect(preloadSource).toContain('ipcRenderer.invoke("desktop:save-project-file", input)');
  });

  it("checks trusted senders and resolves reads through the selected workspace", () => {
    expect(mainSource).toMatch(/ipcMain\.handle\("desktop:list-project-directory"[\s\S]*?assertTrustedSender\(event\)/);
    expect(mainSource).toMatch(/ipcMain\.handle\("desktop:read-project-file"[\s\S]*?assertTrustedSender\(event\)/);
    expect(mainSource).toContain("projects.workspace()");
    expect(mainSource).toContain("readProjectCodeFile(await requireRuntime().projects.workspace(), requestedPath)");
    expect(projectFileSource).toContain("workspace.resolvePath(requestedPath, { mustExist: true })");
  });

  it("validates saves after checking the trusted sender and binds them to the selected workspace", () => {
    expect(mainSource).toMatch(/ipcMain\.handle\("desktop:save-project-file"[\s\S]*?assertTrustedSender\(event\);\s*const input = saveProjectFileSchema\.parse\(raw\)/);
    expect(mainSource).toContain("saveProjectCodeFile(() => requireRuntime().projects.workspace(), input)");
    expect(mainSource).toContain('projectRoot: z.string().min(1).max(4096)');
    expect(mainSource).toContain('Buffer.byteLength(value, "utf8") <= PROJECT_FILE_MAX_BYTES');
    expect(mainSource).toContain('revision: z.string().regex(/^[a-f0-9]{64}$/)');
  });

  it("does not recurse into dependency and generated output folders", () => {
    for (const directory of [".git", "node_modules", "dist", "build", "coverage"]) {
      expect(mainSource).toContain(`\"${directory}\"`);
    }
    expect(mainSource).toContain("PROJECT_DIRECTORY_LIMIT = 2500");
    expect(projectFileSource).toContain("PROJECT_FILE_MAX_BYTES = 1_000_000");
  });
});
