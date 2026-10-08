import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { codebaseMapSnapshotSchema } from "./cache-schema.js";
import { CODEBASE_MAP_CACHE_VERSION } from "./constants.js";
import { shortHash } from "./identity.js";
import type { CodebaseMapSnapshot } from "./types.js";

const MAX_CACHE_BYTES = 250_000_000;

export class CodebaseMapStore {
  constructor(private readonly cacheDirectory: string) {}

  pathFor(root: string): string {
    return join(this.cacheDirectory, `v${CODEBASE_MAP_CACHE_VERSION}`, shortHash(root), "map.json");
  }

  async load(root: string): Promise<CodebaseMapSnapshot | null> {
    const path = this.pathFor(root);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_CACHE_BYTES) return null;
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      const validated = codebaseMapSnapshotSchema.safeParse(parsed);
      return validated.success && validated.data.root === root
        ? validated.data as CodebaseMapSnapshot
        : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async save(snapshot: CodebaseMapSnapshot): Promise<void> {
    const path = this.pathFor(snapshot.root);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  }
}
