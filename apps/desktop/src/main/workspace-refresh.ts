import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const WORKSPACE_REFRESH_COMPLETE_ARGUMENT = "--workspace-refresh-complete";

export interface WorkspaceRefreshOptions {
  isPackaged: boolean;
  resourcesPath: string;
  argv: string[];
  processId: number;
  exit: () => void;
  relaunchCurrent: () => void;
}

interface RefreshProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null) => void): this;
}

type SpawnRefreshProcess = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; windowsHide: boolean },
) => RefreshProcess;

export function workspaceRefreshScript(resourcesPath: string): string | null {
  const markerPath = join(resourcesPath, "browser-agent-workspace.txt");
  if (!existsSync(markerPath)) return null;
  const workspaceRoot = readFileSync(markerPath, "utf8").trim();
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) return null;
  const scriptPath = resolve(workspaceRoot, "scripts", "ensure-desktop-current.ps1");
  return existsSync(scriptPath) ? scriptPath : null;
}

export function startWorkspaceRefresh(
  options: WorkspaceRefreshOptions,
  spawnRefreshProcess: SpawnRefreshProcess = spawn as unknown as SpawnRefreshProcess,
): boolean {
  if (!options.isPackaged || process.platform !== "win32") return false;
  if (options.argv.includes(WORKSPACE_REFRESH_COMPLETE_ARGUMENT)) return false;
  const scriptPath = workspaceRefreshScript(options.resourcesPath);
  if (!scriptPath) return false;

  const updater = spawnRefreshProcess("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-KeepProcessId", String(options.processId),
    "-SkipInstalledSync",
    "-LaunchAfterRefresh",
  ], {
    stdio: "ignore",
    windowsHide: true,
  });
  let finished = false;
  const finish = (refreshSucceeded: boolean): void => {
    if (finished) return;
    finished = true;
    if (!refreshSucceeded) options.relaunchCurrent();
    options.exit();
  };
  updater.once("error", () => finish(false));
  updater.once("exit", (code) => finish(code === 0));
  return true;
}
