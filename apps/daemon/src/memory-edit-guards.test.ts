import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "./approval-manager.js";
import { BrowserBridge } from "./browser-bridge.js";
import { ToolExecutor, type ToolExecutionContext } from "./tool-executor.js";
import { WorkspaceGuard } from "./workspace-guard.js";

let root: string;
let approvals: ApprovalManager;
let tools: ToolExecutor;
let context: ToolExecutionContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "span-memory-edits-"));
  await writeFile(join(root, "source.ts"), "export const value = 1;\r\n");
  approvals = new ApprovalManager();
  tools = new ToolExecutor(approvals, new BrowserBridge());
  context = {
    workspace: await WorkspaceGuard.create(root), signal: new AbortController().signal,
    codebaseMapEnabled: false, sourceReads: new Map(), emit: () => undefined,
    run: { runId: "write-run", sessionId: "write-session", model: "fixture",
      messages: [{ role: "user", content: "Update source" }],
      context: { elements: [], visualChanges: [], attachments: [] }, approvalMode: "auto-safe" },
  };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const replacement = { path: "source.ts", oldText: "value = 1", newText: "value = 2" };
async function inspect(): Promise<{ contentHash: string }> {
  return await tools.execute("fs_read", { path: "source.ts", startLine: 1, endLine: 1 }, context) as { contentHash: string };
}

describe("repository memory source guards", () => {
  it("hashes exact file bytes even when the model reads a line range", async () => {
    const result = await inspect();
    expect(result.contentHash).toBe(createHash("sha256").update(await readFile(join(root, "source.ts"))).digest("hex"));
  });

  it("requires an inspected source before asking for write approval", async () => {
    const approve = vi.spyOn(approvals, "require");
    await expect(tools.execute("fs_replace", replacement, context)).rejects.toMatchObject({ code: "SOURCE_READ_REQUIRED" });
    expect(approve).not.toHaveBeenCalled();
  });

  it("rejects externally changed source before asking for approval", async () => {
    await inspect();
    await writeFile(join(root, "source.ts"), "export const value = 1; // external\n");
    const approve = vi.spyOn(approvals, "require");
    await expect(tools.execute("fs_replace", replacement, context)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(approve).not.toHaveBeenCalled();
  });

  it.each(["fs_replace", "fs_write"])("rejects %s when source changes during approval", async (name) => {
    await inspect();
    vi.spyOn(approvals, "require").mockImplementation(async () => {
      await writeFile(join(root, "source.ts"), "export const value = 1; // concurrent change\n");
    });
    const args = name === "fs_replace" ? replacement : { path: "source.ts", content: "replacement", overwrite: true };
    await expect(tools.execute(name, args, context)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await readFile(join(root, "source.ts"), "utf8")).toContain("concurrent change");
    expect((await readdir(root)).filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps an absent overwrite target create-only during approval", async () => {
    vi.spyOn(approvals, "require").mockImplementation(async () => {
      await writeFile(join(root, "new.ts"), "external new file");
    });
    await expect(tools.execute("fs_write", { path: "new.ts", content: "agent file", overwrite: true }, context))
      .rejects.toMatchObject({ code: "FILE_EXISTS" });
    expect(await readFile(join(root, "new.ts"), "utf8")).toBe("external new file");
  });

  it("permits a fresh guarded edit and requires another read before the next edit", async () => {
    await inspect();
    await tools.execute("fs_replace", replacement, context);
    expect(await readFile(join(root, "source.ts"), "utf8")).toContain("value = 2");
    await expect(tools.execute("fs_replace", { ...replacement, oldText: "value = 2", newText: "value = 3" }, context))
      .rejects.toMatchObject({ code: "SOURCE_READ_REQUIRED" });
  });

  it("preserves the ordinary editor flow when repository memory is off", async () => {
    const { sourceReads: _unused, ...normalContext } = context;
    await tools.execute("fs_replace", replacement, normalContext);
    expect(await readFile(join(root, "source.ts"), "utf8")).toContain("value = 2");
  });

  it("clears observed hashes before a shell command, including a command failure", async () => {
    await inspect();
    vi.spyOn(approvals, "require").mockResolvedValue(undefined);
    await tools.execute("shell_run", { command: "span-missing-fixture-command", args: [] }, context).catch(() => undefined);
    expect(context.sourceReads?.size).toBe(0);
  });
});
