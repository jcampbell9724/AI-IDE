import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError } from "../errors.js";
import { MAX_STATE_BYTES, stateSchema, type MemoryState } from "./schema.js";

// Shared across feature instances in this daemon. A file lock also rejects writers
// from a second daemon instead of allowing last-writer-wins data loss.
const projectWriters = new Map<string, Promise<void>>();

export async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      throw new AppError("MEMORY_FILE_LIMIT", `Repository memory file exceeds the ${maxBytes} byte limit or is not a regular file`);
    }
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (length > maxBytes || length !== info.size || after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      throw new AppError("MEMORY_FILE_CHANGED", "Repository memory file changed while it was being read; retry");
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export class RepositoryMemoryStore {
  constructor(private readonly directory: string) {}

  pathFor(root: string): string {
    return join(this.directory, "v1", createHash("sha256").update(root).digest("hex"), "memory.json");
  }

  async load(root: string): Promise<MemoryState> {
    try {
      const parsed = stateSchema.safeParse(JSON.parse((await readBounded(this.pathFor(root), MAX_STATE_BYTES)).toString("utf8")));
      if (!parsed.success || parsed.data.root !== root) throw new Error("Schema or project identity mismatch");
      const state = parsed.data;
      if (new Set(state.handoffs.map((entry) => entry.sessionId)).size !== state.handoffs.length ||
          new Set(state.notes.map((entry) => entry.id)).size !== state.notes.length ||
          new Set(state.runs.map((entry) => entry.runId)).size !== state.runs.length) {
        throw new Error("Duplicate memory record identity");
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, root, handoffs: [], notes: [], runs: [] };
      throw new AppError("MEMORY_STATE_INVALID", "Saved repository memory cannot be read. The original file was retained; repair or move it before retrying.", 409,
        { path: this.pathFor(root), reason: error instanceof Error ? error.message : String(error) });
    }
  }

  async update<T>(root: string, assertActive: () => void, mutate: (state: MemoryState) => Promise<T> | T): Promise<T> {
    const path = this.pathFor(root);
    const previous = projectWriters.get(path) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    projectWriters.set(path, pending);
    await previous;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let temporary: string | undefined;
    try {
      assertActive();
      await mkdir(dirname(path), { recursive: true });
      assertActive();
      try {
        lock = await open(`${path}.lock`, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new AppError("MEMORY_BUSY", "Another repository memory writer holds the project lock. Retry after it finishes; a lock left by a crashed app must be removed after confirming the app is stopped.", 409);
        }
        throw error;
      }
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      assertActive();
      const state = await this.load(root);
      assertActive();
      const result = await mutate(state);
      assertActive();
      const text = `${JSON.stringify(stateSchema.parse(state))}\n`;
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new AppError("MEMORY_STATE_LIMIT", "Repository memory reached its storage limit");
      temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      const output = await open(temporary, "wx", 0o600);
      try {
        await output.writeFile(text, "utf8");
        await output.sync();
      } finally {
        await output.close();
      }
      assertActive();
      await rename(temporary, path);
      temporary = undefined;
      return result;
    } finally {
      try {
        if (temporary) await unlink(temporary).catch(() => undefined);
        if (lock) {
          await lock.close();
          await unlink(`${path}.lock`).catch(() => undefined);
        }
      } finally {
        release();
        if (projectWriters.get(path) === pending) projectWriters.delete(path);
      }
    }
  }
}
