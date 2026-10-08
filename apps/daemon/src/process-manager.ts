import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { DevLogEntry, DevProcessState } from "@browser-agent/shared";
import { sanitizedChildEnvironment } from "./child-env.js";
import { AppError } from "./errors.js";
import { commandInvocation, parseCommandLine } from "./command.js";
import { WorkspaceGuard } from "./workspace-guard.js";

export interface ProcessStatus {
  readonly state: DevProcessState;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly exitCode: number | null;
  readonly command: string | null;
  readonly error?: string;
}

export class DevProcessManager {
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private state: DevProcessState = "stopped";
  private startedAt: string | null = null;
  private exitCode: number | null = null;
  private commandLine: string | null = null;
  private lastError: string | undefined;
  private sequence = 0;
  private readonly logs: DevLogEntry[] = [];

  status(): ProcessStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      exitCode: this.exitCode,
      command: this.commandLine,
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
    };
  }

  logsAfter(after: number): { logs: DevLogEntry[]; next: number } {
    return {
      logs: this.logs.filter((entry) => entry.seq > after),
      next: this.sequence,
    };
  }

  clearLogs(): void {
    if (this.child) throw new AppError("PROCESS_RUNNING", "Cannot clear logs while the process is running", 409);
    this.logs.length = 0;
    this.sequence = 0;
  }

  async start(guard: WorkspaceGuard, commandLine: string): Promise<ProcessStatus> {
    if (this.child && ["starting", "running", "restarting"].includes(this.state)) {
      throw new AppError("PROCESS_ALREADY_RUNNING", "The development process is already running", 409);
    }
    const parsed = parseCommandLine(commandLine);
    const invocation = commandInvocation(parsed.command, parsed.args);
    this.state = "starting";
    this.exitCode = null;
    this.lastError = undefined;
    this.commandLine = commandLine;
    this.append("system", `Starting: ${commandLine}`);

    const child = spawn(invocation.command, invocation.args, {
      cwd: guard.root,
      env: sanitizedChildEnvironment(),
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.append("stdout", chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => this.append("stderr", chunk.toString("utf8")));
    child.on("error", (error) => {
      if (this.child === child && !child.pid) this.child = undefined;
      this.state = "failed";
      this.lastError = error.message;
      this.append("system", `Failed to start: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      this.exitCode = code;
      if (this.child === child) this.child = undefined;
      if (this.state !== "stopping" && this.state !== "restarting") {
        this.state = code === 0 ? "stopped" : "failed";
      }
      if (code !== null && code !== 0) this.lastError ??= `Process exited with code ${code}`;
      this.append("system", `Process exited (${code ?? signal ?? "unknown"})`);
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    this.state = "running";
    this.startedAt = new Date().toISOString();
    return this.status();
  }

  async stop(): Promise<ProcessStatus> {
    const child = this.child;
    if (!child?.pid) {
      this.child = undefined;
      this.state = "stopped";
      return this.status();
    }
    this.state = "stopping";
    this.append("system", "Stopping development process");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t"], {
        env: sanitizedChildEnvironment(),
        windowsHide: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolve) => killer.once("exit", () => resolve()));
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!graceful && child.pid) {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          env: sanitizedChildEnvironment(),
          windowsHide: true,
          stdio: "ignore",
        });
        await new Promise<void>((resolve) => killer.once("exit", () => resolve()));
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      await exited;
    }
    if (this.child === child) this.child = undefined;
    this.state = "stopped";
    return this.status();
  }

  async restart(guard: WorkspaceGuard, commandLine: string): Promise<ProcessStatus> {
    this.state = "restarting";
    await this.stop();
    return this.start(guard, commandLine);
  }

  private append(stream: DevLogEntry["stream"], text: string): void {
    const clipped = text.length > 100_000 ? `${text.slice(0, 100_000)}\n[truncated]` : text;
    this.sequence += 1;
    this.logs.push({
      seq: this.sequence,
      timestamp: new Date().toISOString(),
      stream,
      text: clipped,
    });
    if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
  }
}
