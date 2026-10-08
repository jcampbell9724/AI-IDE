import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceGuard } from "../../../daemon/src/workspace-guard";
import { PROJECT_FILE_MAX_BYTES, readProjectCodeFile, saveProjectCodeFile } from "./project-files";

const executeFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: executeFile }));
const temporaryDirectories: string[] = [];

beforeEach(() => {
  executeFile.mockReset();
  executeFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error) => void) => {
    callback(Object.assign(new Error("Not a Git repository"), { stderr: Buffer.from("not a git repository") }));
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), "span-project-files-"))) throw new Error("Unexpected test cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(content = "first\r\nsecond\r\n"): Promise<WorkspaceGuard> {
  const root = await mkdtemp(join(tmpdir(), "span-project-files-"));
  temporaryDirectories.push(root);
  await writeFile(join(root, "sample.ts"), content, "utf8");
  return WorkspaceGuard.create(root);
}

describe("desktop project files", () => {
  it("returns project identity, original-byte revision, and line endings without passing provider secrets to Git", async () => {
    const workspace = await fixture();
    vi.stubEnv("OPENROUTER_API_KEY", "test-provider-secret");
    vi.stubEnv("BROWSER_AGENT_TOKEN", "test-daemon-secret");
    const result = await readProjectCodeFile(workspace, "sample.ts");

    expect(result).toMatchObject({
      path: "sample.ts", projectRoot: workspace.root, content: "first\nsecond\n",
      lineEnding: "CRLF", truncated: false, totalLines: 3,
      revision: createHash("sha256").update("first\r\nsecond\r\n").digest("hex"),
    });
    const options = executeFile.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(options.env).not.toHaveProperty("BROWSER_AGENT_TOKEN");
    expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("saves against the current revision and preserves the file's line endings", async () => {
    const workspace = await fixture();
    const original = await readProjectCodeFile(workspace, "sample.ts");
    const saved = await saveProjectCodeFile(async () => workspace, { ...original, content: "changed\nsecond\n" });

    expect(await readFile(join(workspace.root, "sample.ts"), "utf8")).toBe("changed\r\nsecond\r\n");
    expect(saved.content).toBe("changed\nsecond\n");
    expect(saved.revision).not.toBe(original.revision);
    expect(saved.revision).toBe(createHash("sha256").update("changed\r\nsecond\r\n").digest("hex"));
  });

  it("rejects stale revisions and preserves the external edit", async () => {
    const workspace = await fixture();
    const original = await readProjectCodeFile(workspace, "sample.ts");
    await writeFile(join(workspace.root, "sample.ts"), "external change\n");

    await expect(saveProjectCodeFile(async () => workspace, { ...original, content: "my edit\n" })).rejects.toThrow("changed on disk");
    expect(await readFile(join(workspace.root, "sample.ts"), "utf8")).toBe("external change\n");
    expect(await readdir(workspace.root)).toEqual(["sample.ts"]);
  });

  it("rechecks the selected project before replacing a file and cleans up the temporary edit", async () => {
    const workspace = await fixture();
    const other = await fixture("other project\n");
    const original = await readProjectCodeFile(workspace, "sample.ts");
    let selections = 0;

    await expect(saveProjectCodeFile(async () => selections++ === 0 ? workspace : other, { ...original, content: "my edit\n" })).rejects.toThrow("selected project changed");
    expect(await readFile(join(workspace.root, "sample.ts"), "utf8")).toBe("first\r\nsecond\r\n");
    expect(await readFile(join(other.root, "sample.ts"), "utf8")).toBe("other project\n");
    expect(await readdir(workspace.root)).toEqual(["sample.ts"]);
  });

  it("rejects paths outside the selected workspace", async () => {
    const workspace = await fixture();
    await expect(readProjectCodeFile(workspace, "../outside.ts")).rejects.toThrow("outside the selected workspace");
    await expect(saveProjectCodeFile(async () => workspace, {
      path: "../outside.ts", projectRoot: workspace.root, revision: "0".repeat(64), content: "edit",
    })).rejects.toThrow("outside the selected workspace");
  });

  it("rejects an oversized edit without changing the file", async () => {
    const workspace = await fixture();
    const original = await readProjectCodeFile(workspace, "sample.ts");
    await expect(saveProjectCodeFile(async () => workspace, { ...original, content: "x".repeat(PROJECT_FILE_MAX_BYTES + 1) })).rejects.toThrow("exceeds the 1 MB");
    expect(await readFile(join(workspace.root, "sample.ts"), "utf8")).toBe("first\r\nsecond\r\n");
  });
});
