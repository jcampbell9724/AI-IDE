import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceGuard } from "./workspace-guard.js";

const temporaryDirectories: string[] = [];

async function temporary(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `${name}-`));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WorkspaceGuard", () => {
  it("accepts existing and new paths inside the canonical root", async () => {
    const root = await temporary("guard-root");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export {};\n");
    const guard = await WorkspaceGuard.create(root);

    await expect(guard.resolvePath("src/index.ts", { mustExist: true })).resolves.toBe(
      join(root, "src", "index.ts"),
    );
    await expect(guard.resolvePath("src/new.ts")).resolves.toBe(join(root, "src", "new.ts"));
  });

  it("rejects lexical traversal and absolute paths outside the root", async () => {
    const root = await temporary("guard-root");
    const outside = await temporary("guard-outside");
    const guard = await WorkspaceGuard.create(root);

    await expect(guard.resolvePath("../guard-outside/secret.txt")).rejects.toMatchObject({
      code: "WORKSPACE_ESCAPE",
    });
    await expect(guard.resolvePath(join(outside, "secret.txt"))).rejects.toMatchObject({
      code: "WORKSPACE_ESCAPE",
    });
  });

  it("rejects a symlink or junction whose canonical target escapes", async () => {
    const root = await temporary("guard-root");
    const outside = await temporary("guard-outside");
    await writeFile(join(outside, "secret.txt"), "secret");
    try {
      await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    const guard = await WorkspaceGuard.create(root);

    await expect(guard.resolvePath("escape/secret.txt", { mustExist: true })).rejects.toMatchObject({
      code: "WORKSPACE_ESCAPE",
    });
    await expect(guard.resolvePath("escape/new.txt")).rejects.toMatchObject({
      code: "WORKSPACE_ESCAPE",
    });
  });
});
