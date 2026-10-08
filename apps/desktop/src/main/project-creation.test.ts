import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectDirectory, normalizeProjectName } from "./project-creation";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("project creation", () => {
  it("normalizes a safe project name", () => {
    expect(normalizeProjectName("  My new app  ")).toBe("My new app");
    expect(normalizeProjectName("旅行-planner")).toBe("旅行-planner");
  });

  it.each(["", ".", "..", "bad/name", "bad\\name", "bad:name", "name. ", "CON", "con.txt", "COM1", "LPT9.demo"])("rejects the invalid name %j", (name) => {
    expect(() => normalizeProjectName(name)).toThrow();
  });

  it("creates one empty project directory inside the selected parent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "browser-agent-project-"));
    temporaryDirectories.push(parent);
    const target = await createProjectDirectory(parent, "new-project");
    expect(target).toBe(join(parent, "new-project"));
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it("does not reuse an existing directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "browser-agent-project-"));
    temporaryDirectories.push(parent);
    await mkdir(join(parent, "existing"));
    await expect(createProjectDirectory(parent, "existing")).rejects.toThrow("already exists");
  });
});
