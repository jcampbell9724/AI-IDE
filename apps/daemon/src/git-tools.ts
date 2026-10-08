import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { z } from "zod";
import { GitDiffArgsSchema, GitLogArgsSchema } from "@browser-agent/shared";
import { sanitizedChildEnvironment } from "./child-env.js";
import { AppError, throwIfAborted } from "./errors.js";
import { WorkspaceGuard } from "./workspace-guard.js";

const execFileAsync = promisify(execFile);
type DiffArgs = z.infer<typeof GitDiffArgsSchema>;
type LogArgs = z.infer<typeof GitLogArgsSchema>;

export class GitTools {
  constructor(private readonly guard: WorkspaceGuard) {}

  status(signal?: AbortSignal): Promise<unknown> {
    return this.run(["status", "--porcelain=v2", "--branch"], signal);
  }

  async diff(input: DiffArgs, signal?: AbortSignal): Promise<unknown> {
    const args = GitDiffArgsSchema.parse(input);
    const gitArgs = ["diff", "--no-ext-diff", "--unified=3"];
    if (args.staged) gitArgs.push("--cached");
    if (args.path !== undefined) {
      const resolved = await this.guard.resolvePath(args.path, { mustExist: true });
      gitArgs.push("--", this.guard.relative(resolved));
    }
    return this.run(gitArgs, signal);
  }

  log(input: LogArgs, signal?: AbortSignal): Promise<unknown> {
    const args = GitLogArgsSchema.parse(input);
    return this.run(
      [
        "log",
        `--max-count=${args.maxCount}`,
        "--date=iso-strict",
        "--pretty=format:%H%x09%ad%x09%an%x09%s",
      ],
      signal,
    );
  }

  private async run(args: string[], signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    try {
      const result = await execFileAsync("git", args, {
        cwd: this.guard.root,
        env: sanitizedChildEnvironment(),
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 5_000_000,
        windowsHide: true,
        ...(signal === undefined ? {} : { signal }),
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: string | number;
      };
      throw new AppError(
        "GIT_FAILED",
        failure.stderr?.trim() || failure.message || "Git command failed",
        409,
        { stdout: failure.stdout, exitCode: failure.code },
      );
    }
  }
}
