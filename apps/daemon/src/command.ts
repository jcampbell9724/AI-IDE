import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizedChildEnvironment } from "./child-env.js";
import { AppError, throwIfAborted } from "./errors.js";
import { WorkspaceGuard } from "./workspace-guard.js";

const execFileAsync = promisify(execFile);

export interface ParsedCommand {
  readonly command: string;
  readonly args: string[];
}

export function parseCommandLine(input: string): ParsedCommand {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  if (/[\r\n\0]/.test(input)) {
    throw new AppError("UNSAFE_COMMAND_LINE", "Compound commands and multiline commands are not accepted; run one command at a time");
  }
  const source = input.trim();

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      tokenStarted = true;
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    if (/[&|<>;\r\n]/.test(character)) {
      throw new AppError(
        "UNSAFE_COMMAND_LINE",
        "Compound commands and shell redirection are not accepted; run one structured command at a time",
      );
    }
    tokenStarted = true;
    token += character;
  }
  if (quote) throw new AppError("INVALID_COMMAND_LINE", "Unterminated quote");
  if (tokenStarted) tokens.push(token);
  const [command, ...args] = tokens;
  if (!command) throw new AppError("INVALID_COMMAND_LINE", "Command is empty");
  return { command, args };
}

function assertWindowsShimSafe(values: readonly string[]): void {
  for (const value of values) {
    if (/["%!?&|<>^()\r\n]/.test(value)) {
      throw new AppError("UNSAFE_COMMAND_ARGUMENT", "Command argument contains shell metacharacters");
    }
  }
}

const WINDOWS_PACKAGE_SHIMS = new Set(["npm", "npm.cmd", "npx", "npx.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun.cmd"]);

export function commandInvocation(command: string, args: string[]): ParsedCommand {
  if (process.platform !== "win32" || !WINDOWS_PACKAGE_SHIMS.has(command.toLowerCase())) {
    return { command, args };
  }
  assertWindowsShimSafe(args);
  const shim = command.toLowerCase().endsWith(".cmd") ? command : `${command}.cmd`;
  const line = [shim, ...args.map((argument) => `"${argument}"`)].join(" ");
  return {
    command: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", line],
  };
}

export async function runBoundedCommand(
  guard: WorkspaceGuard,
  input: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
  },
  signal?: AbortSignal,
): Promise<unknown> {
  const cwd = await guard.resolvePath(input.cwd, { mustExist: true });
  throwIfAborted(signal);
  const invocation = commandInvocation(input.command, input.args);
  try {
    const result = await execFileAsync(invocation.command, invocation.args, {
      cwd,
      env: sanitizedChildEnvironment(),
      encoding: "utf8",
      timeout: input.timeoutMs,
      maxBuffer: 5_000_000,
      windowsHide: true,
      shell: false,
      ...(signal === undefined ? {} : { signal }),
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
      killed?: boolean;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      exitCode: typeof failure.code === "number" ? failure.code : null,
      killed: failure.killed ?? false,
      error: failure.message,
    };
  }
}
