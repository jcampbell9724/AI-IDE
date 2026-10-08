import { afterEach, describe, expect, it, vi } from "vitest";
import { commandInvocation, parseCommandLine, runBoundedCommand } from "./command.js";
import { WorkspaceGuard } from "./workspace-guard.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseCommandLine", () => {
  it("preserves empty quoted arguments and rejects an empty executable", () => {
    expect(parseCommandLine('node app.js --label ""')).toEqual({ command: "node", args: ["app.js", "--label", ""] });
    expect(() => parseCommandLine('"" app.js')).toThrow("Command is empty");
  });

  it.each(["node app.js\nnpm publish", "node app.js\r\nnpm publish", 'node "a\nb"', "node app.js\0"])("rejects multiline and null-containing input: %j", (command) => {
    expect(() => parseCommandLine(command)).toThrow();
  });

  it("runs Bun directly rather than assuming a Windows command shim", () => {
    expect(commandInvocation("bun", ["run", "dev"])).toEqual({ command: "bun", args: ["run", "dev"] });
  });

  it("preserves unquoted and quoted Windows backslashes", () => {
    expect(parseCommandLine(String.raw`python C:\work\app.py`)).toEqual({
      command: "python",
      args: [String.raw`C:\work\app.py`],
    });
    expect(parseCommandLine(String.raw`python "C:\Program Files\demo\app.py"`)).toEqual({
      command: "python",
      args: [String.raw`C:\Program Files\demo\app.py`],
    });
  });

  it("rejects shell chaining and redirection", () => {
    expect(() => parseCommandLine("npm test && npm publish")).toThrow(/Compound commands/);
    expect(() => parseCommandLine("npm test > output.txt")).toThrow(/Compound commands/);
  });

  it("does not expose daemon or provider credentials to commands", async () => {
    vi.stubEnv("BROWSER_AGENT_TOKEN", "daemon-secret");
    vi.stubEnv("OPENROUTER_API_KEY", "provider-secret");
    vi.stubEnv("PROJECT_SETTING", "visible");
    const guard = await WorkspaceGuard.create(process.cwd());

    const result = await runBoundedCommand(guard, {
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write([process.env.BROWSER_AGENT_TOKEN, process.env.OPENROUTER_API_KEY, process.env.PROJECT_SETTING].map(String).join('|'))",
      ],
      cwd: ".",
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      stdout: "undefined|undefined|visible",
      stderr: "",
      exitCode: 0,
    });
  });
});
