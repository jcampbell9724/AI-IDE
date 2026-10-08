import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectService } from "./project-service.js";
import { ProjectStore } from "./project-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function serviceFor(root: string): Promise<ProjectService> {
  return new ProjectService(new ProjectStore(join(root, ".browser-agent-state.json")));
}

describe("ProjectService development commands", () => {
  it("reopens detected projects with fresh commands and preserves saved custom commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-command-reopen-"));
    temporaryDirectories.push(root);
    const projects = await serviceFor(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    await projects.select({ path: root, url: "http://localhost:5173/" });
    await projects.clearCurrent();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { serve: "vite" } }));
    await projects.select({ path: root });
    expect(await projects.current()).toMatchObject({
      devCommand: "npm run serve", devCommandSource: "detected", url: "http://localhost:5173/",
    });
    await projects.select({ path: root, devCommand: "node custom.js" });
    await projects.clearCurrent();
    await projects.select({ path: root });
    expect(await projects.current()).toMatchObject({ devCommand: "node custom.js", devCommandSource: "custom" });
    await projects.select({ path: root, devCommand: "" });
    expect(await projects.current()).toMatchObject({ devCommand: "npm run serve", devCommandSource: "detected" });
  });

  it("refreshes detected commands after reload and removes obsolete commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-command-refresh-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    await (await serviceFor(root)).select({ path: root });
    const projects = await serviceFor(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@11.0.0", scripts: { serve: "vite" } }));
    expect(await projects.ensureDevCommand()).toBe("pnpm run serve");
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
    expect(await projects.ensureDevCommand()).toBeNull();
    expect(await projects.current()).toMatchObject({ devCommand: null, detection: { scripts: { build: "vite build" } } });
  });

  it("preserves an explicit override even when it matches the originally detected command", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-command-explicit-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    await (await serviceFor(root)).select({ path: root, devCommand: "npm run dev" });
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { serve: "vite" } }));
    expect(await (await serviceFor(root)).ensureDevCommand()).toBe("npm run dev");
  });

  it("rejects invalid overrides before replacing the selected project", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-command-invalid-"));
    temporaryDirectories.push(root);
    const projects = await serviceFor(root);
    await projects.select({ path: root, devCommand: "node server.js" });
    await expect(projects.select({ path: root, devCommand: "npm run dev && npm run build" })).rejects.toThrow("Compound commands");
    expect((await projects.current()).devCommand).toBe("node server.js");
  });

  it("keeps an explicit saved override instead of re-detecting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-command-override-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    const projects = await serviceFor(root);
    await projects.select({ path: root, devCommand: "node custom-server.js" });

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { "start:dev": "vite --host" } }),
    );

    expect(await projects.ensureDevCommand()).toBe("node custom-server.js");
    expect((await projects.current()).devCommand).toBe("node custom-server.js");
  });

  it("lazily detects and persists a command when the selected project had none", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-command-lazy-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo" }));
    const projects = await serviceFor(root);
    await projects.select({ path: root });
    expect((await projects.current()).devCommand).toBeNull();

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@11.0.0",
        scripts: { develop: "vite --host" },
      }),
    );

    expect(await projects.ensureDevCommand()).toBe("pnpm run develop");
    expect((await projects.current()).devCommand).toBe("pnpm run develop");
  });

  it("returns null when re-detection still finds no runnable command", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-command-missing-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "library" }));
    const projects = await serviceFor(root);
    await projects.select({ path: root });

    expect(await projects.ensureDevCommand()).toBeNull();
    expect((await projects.current()).devCommand).toBeNull();
  });
});

describe("ProjectService history", () => {
  it("does not attach an old startup URL to a newly selected project", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-stale-preview-"));
    temporaryDirectories.push(root);
    const second = join(root, "second");
    await mkdir(second);
    const projects = await serviceFor(root);
    await projects.select({ path: root });
    await projects.select({ path: second });
    await expect(projects.setPreviewUrl("http://localhost:5174/", root)).rejects.toMatchObject({ code: "PROJECT_CHANGED" });
    expect((await projects.current()).url).toBeNull();
  });

  it("saves preview discovery while an agent is running without allowing a project switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-preview-while-running-"));
    temporaryDirectories.push(root);
    const projects = await serviceFor(root);
    await projects.select({ path: root, devCommand: "node server.js" });
    const release = projects.lockSelection();
    try {
      await projects.setPreviewUrl("http://localhost:5174/");
      expect(await projects.current()).toMatchObject({ root, devCommand: "node server.js", url: "http://localhost:5174/" });
      await expect(projects.select({ path: root })).rejects.toMatchObject({ code: "PROJECT_IN_USE" });
    } finally { release(); }
  });

  it("persists the preview URL without changing the project or its command", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-preview-url-"));
    temporaryDirectories.push(root);
    const projects = await serviceFor(root);
    await projects.select({ path: root, devCommand: "node server.js" });
    await projects.setPreviewUrl("http://localhost:5173/");
    const reloaded = await serviceFor(root);
    expect(await reloaded.current()).toMatchObject({ root, devCommand: "node server.js", url: "http://localhost:5173/" });
    expect((await reloaded.getState()).recent[0]?.url).toBe("http://localhost:5173/");
  });
  it("starts a new app session with no project selected while retaining history", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-session-empty-"));
    temporaryDirectories.push(root);
    const first = join(root, "first");
    await mkdir(first);
    await writeFile(join(first, "package.json"), JSON.stringify({ name: "first" }));
    const stateFile = join(root, ".browser-agent-state.json");
    const projects = new ProjectService(new ProjectStore(stateFile));
    await projects.select({ path: first });

    await projects.clearCurrent();

    const state = await projects.getState();
    expect(state.current).toBeNull();
    expect(state.recent.map((project) => project.root)).toEqual([first]);
    await expect(projects.current()).rejects.toThrow("Select a project first");

    const reloaded = new ProjectService(new ProjectStore(stateFile));
    expect((await reloaded.getState()).current).toBeNull();
    expect((await reloaded.getState()).recent.map((project) => project.root)).toEqual([first]);
  });

  it("pins and removes historical projects without closing the current project", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-history-"));
    temporaryDirectories.push(root);
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, "package.json"), JSON.stringify({ name: "first" }));
    await writeFile(join(second, "package.json"), JSON.stringify({ name: "second" }));
    const projects = await serviceFor(root);
    await projects.select({ path: first });
    await projects.select({ path: second });

    await projects.setPinned(first, true);
    expect((await projects.getState()).pinned).toEqual([first]);

    await projects.removeRecent(first);
    const state = await projects.getState();
    expect(state.current?.root).toBe(second);
    expect(state.recent.map((project) => project.root)).toEqual([second]);
    expect(state.pinned).toEqual([]);
  });
});
