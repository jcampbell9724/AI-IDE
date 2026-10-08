import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startWorkspaceRefresh, workspaceRefreshScript } from "./workspace-refresh";

async function refreshFixture(): Promise<{ resources: string; updater: string }> {
  const root = await mkdtemp(join(tmpdir(), "browser-agent-refresh-"));
  const resources = join(root, "installed", "resources");
  const scripts = join(root, "workspace", "scripts");
  await mkdir(resources, { recursive: true });
  await mkdir(scripts, { recursive: true });
  const updater = join(scripts, "ensure-desktop-current.ps1");
  await writeFile(updater, "# updater");
  await writeFile(join(resources, "browser-agent-workspace.txt"), join(root, "workspace"));
  return { resources, updater };
}

describe("workspace refresh", () => {
  it("resolves the updater from the packaged workspace marker", async () => {
    const { resources, updater } = await refreshFixture();

    expect(workspaceRefreshScript(resources)).toBe(updater);
  });

  it("does not trust a missing or relative workspace marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-agent-refresh-"));
    await writeFile(join(root, "browser-agent-workspace.txt"), "relative/path");
    expect(workspaceRefreshScript(root)).toBeNull();
  });

  it("keeps the bootstrap alive until refresh completes", async () => {
    const { resources, updater } = await refreshFixture();
    const child = new EventEmitter();
    const exit = vi.fn();
    const relaunchCurrent = vi.fn();
    const spawnRefresh = vi.fn(() => child as never);

    expect(startWorkspaceRefresh({
      isPackaged: true,
      resourcesPath: resources,
      argv: ["Browser Agent.exe"],
      processId: 42,
      exit,
      relaunchCurrent,
    }, spawnRefresh)).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(spawnRefresh).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining([
      "-File", updater, "-KeepProcessId", "42", "-SkipInstalledSync", "-LaunchAfterRefresh",
    ]), expect.any(Object));

    child.emit("exit", 0);
    expect(exit).toHaveBeenCalledOnce();
    expect(relaunchCurrent).not.toHaveBeenCalled();
  });

  it("falls back to the installed app when refresh fails", async () => {
    const { resources } = await refreshFixture();
    const child = new EventEmitter();
    const exit = vi.fn();
    const relaunchCurrent = vi.fn();

    startWorkspaceRefresh({
      isPackaged: true,
      resourcesPath: resources,
      argv: ["Browser Agent.exe"],
      processId: 42,
      exit,
      relaunchCurrent,
    }, () => child as never);
    child.emit("exit", 1);

    expect(relaunchCurrent).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });
});
