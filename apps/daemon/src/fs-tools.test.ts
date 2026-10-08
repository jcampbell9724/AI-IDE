import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTools } from "./fs-tools.js";
import { WorkspaceGuard } from "./workspace-guard.js";

let root: string;
let tools: FileTools;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fs-tools-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "alpha.ts"), "one\ntarget value\nthree\n");
  await writeFile(join(root, "src", "beta.ts"), "another target\n");
  tools = new FileTools(await WorkspaceGuard.create(root));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FileTools", () => {
  it("lists, reads, and searches bounded project content", async () => {
    const listed = (await tools.list({ path: ".", depth: 2, maxEntries: 20 })) as {
      entries: Array<{ path: string }>;
    };
    expect(listed.entries.map((entry) => entry.path)).toContain("src/alpha.ts");

    const read = (await tools.read({
      path: "src/alpha.ts",
      startLine: 2,
      endLine: 2,
      maxLines: 10,
      maxBytes: 1000,
    })) as { content: string; startLine: number; endLine: number };
    expect(read).toMatchObject({ content: "target value", startLine: 2, endLine: 2 });

    const searched = (await tools.search({
      path: "src",
      query: "target",
      regex: false,
      caseSensitive: false,
      extensions: ["ts"],
      maxResults: 10,
    })) as { matches: Array<{ path: string; line: number }> };
    expect(searched.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/alpha.ts", line: 2 }),
        expect.objectContaining({ path: "src/beta.ts", line: 1 }),
      ]),
    );
  });

  it("requires an exact occurrence count for targeted replacement", async () => {
    await expect(
      tools.replace({
        path: "src/alpha.ts",
        oldText: "target",
        newText: "updated",
        expectedOccurrences: 2,
      }),
    ).rejects.toMatchObject({ code: "REPLACE_COUNT_MISMATCH" });

    await tools.replace({
      path: "src/alpha.ts",
      oldText: "target",
      newText: "updated",
      expectedOccurrences: 1,
    });
    await expect(readFile(join(root, "src", "alpha.ts"), "utf8")).resolves.toContain(
      "updated value",
    );
  });

  it("creates safely and refuses accidental overwrite", async () => {
    await tools.write({ path: "nested/new.txt", content: "created", overwrite: false });
    await expect(readFile(join(root, "nested", "new.txt"), "utf8")).resolves.toBe("created");
    await expect(
      tools.write({ path: "nested/new.txt", content: "lost", overwrite: false }),
    ).rejects.toMatchObject({ code: "FILE_EXISTS" });
    await expect(readFile(join(root, "nested", "new.txt"), "utf8")).resolves.toBe("created");
  });
});
