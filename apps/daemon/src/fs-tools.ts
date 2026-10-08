import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  FsListArgsSchema,
  FsReadArgsSchema,
  FsReplaceArgsSchema,
  FsSearchArgsSchema,
  FsWriteArgsSchema,
} from "@browser-agent/shared";
import { AppError, throwIfAborted } from "./errors.js";
import { WorkspaceGuard } from "./workspace-guard.js";

type ListArgs = z.infer<typeof FsListArgsSchema>;
type ReadArgs = z.infer<typeof FsReadArgsSchema>;
type SearchArgs = z.infer<typeof FsSearchArgsSchema>;
type ReplaceArgs = z.infer<typeof FsReplaceArgsSchema>;
type WriteArgs = z.infer<typeof FsWriteArgsSchema>;

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
]);

function apiPath(root: string, path: string): string {
  return (relative(root, path) || ".").replaceAll("\\", "/");
}

export class FileTools {
  constructor(private readonly guard: WorkspaceGuard) {}

  async list(input: ListArgs, signal?: AbortSignal): Promise<unknown> {
    const args = FsListArgsSchema.parse(input);
    const base = await this.guard.resolvePath(args.path, { mustExist: true });
    const entries: Array<{ path: string; kind: "file" | "directory" | "symlink"; size?: number }> = [];

    const visit = async (directory: string, remainingDepth: number): Promise<void> => {
      throwIfAborted(signal);
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (entries.length >= args.maxEntries) return;
        const path = join(directory, child.name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
          entries.push({ path: apiPath(this.guard.root, path), kind: "symlink" });
          continue;
        }
        if (info.isDirectory()) {
          entries.push({ path: apiPath(this.guard.root, path), kind: "directory" });
          if (remainingDepth > 0 && !SKIPPED_DIRECTORIES.has(child.name)) {
            await visit(path, remainingDepth - 1);
          }
        } else if (info.isFile()) {
          entries.push({ path: apiPath(this.guard.root, path), kind: "file", size: info.size });
        }
      }
    };

    const baseInfo = await stat(base);
    if (baseInfo.isDirectory()) await visit(base, args.depth);
    else entries.push({ path: apiPath(this.guard.root, base), kind: "file", size: baseInfo.size });
    return { root: apiPath(this.guard.root, base), entries, truncated: entries.length >= args.maxEntries };
  }

  async read(input: ReadArgs, signal?: AbortSignal): Promise<unknown> {
    const args = FsReadArgsSchema.parse(input);
    const path = await this.guard.resolvePath(args.path, { mustExist: true });
    const info = await stat(path);
    if (!info.isFile()) throw new AppError("NOT_A_FILE", "Path is not a file");
    if (info.size > args.maxBytes) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `File is ${info.size} bytes; requested maximum is ${args.maxBytes}`,
        413,
      );
    }
    throwIfAborted(signal);
    const bytes = await readFile(path);
    const text = bytes.toString("utf8");
    const lines = text.split(/\r?\n/);
    const startIndex = args.startLine - 1;
    const requestedEnd = args.endLine ?? startIndex + args.maxLines;
    const endIndex = Math.min(lines.length, requestedEnd, startIndex + args.maxLines);
    return {
      path: apiPath(this.guard.root, path),
      startLine: args.startLine,
      endLine: endIndex,
      totalLines: lines.length,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      content: lines.slice(startIndex, endIndex).join("\n"),
      truncated: endIndex < lines.length,
    };
  }

  async search(input: SearchArgs, signal?: AbortSignal): Promise<unknown> {
    const args = FsSearchArgsSchema.parse(input);
    const base = await this.guard.resolvePath(args.path, { mustExist: true });
    const flags = args.caseSensitive ? "g" : "gi";
    let matcher: RegExp | undefined;
    if (args.regex) {
      try {
        matcher = new RegExp(args.query, flags);
      } catch (error) {
        throw new AppError("INVALID_REGEX", (error as Error).message);
      }
    }
    const needle = args.caseSensitive ? args.query : args.query.toLowerCase();
    const normalizedExtensions = new Set(
      args.extensions.map((extension) =>
        extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`,
      ),
    );
    const matches: Array<{ path: string; line: number; column: number; preview: string }> = [];
    let filesScanned = 0;

    const inspectFile = async (path: string): Promise<void> => {
      if (matches.length >= args.maxResults || filesScanned >= 5000) return;
      if (normalizedExtensions.size > 0 && !normalizedExtensions.has(extname(path).toLowerCase())) return;
      const info = await stat(path);
      if (!info.isFile() || info.size > 1_000_000) return;
      filesScanned += 1;
      const text = await readFile(path, "utf8");
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < args.maxResults; index += 1) {
        throwIfAborted(signal);
        const line = lines[index] ?? "";
        let column = -1;
        if (matcher) {
          matcher.lastIndex = 0;
          column = matcher.exec(line.slice(0, 50_000))?.index ?? -1;
        } else {
          column = (args.caseSensitive ? line : line.toLowerCase()).indexOf(needle);
        }
        if (column >= 0) {
          matches.push({
            path: apiPath(this.guard.root, path),
            line: index + 1,
            column: column + 1,
            preview: line.slice(Math.max(0, column - 120), column + 500),
          });
        }
      }
    };

    const walk = async (path: string): Promise<void> => {
      throwIfAborted(signal);
      if (matches.length >= args.maxResults || filesScanned >= 5000) return;
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      if (info.isFile()) return inspectFile(path);
      if (!info.isDirectory()) return;
      const children = await readdir(path, { withFileTypes: true });
      for (const child of children) {
        if (SKIPPED_DIRECTORIES.has(child.name)) continue;
        await walk(join(path, child.name));
        if (matches.length >= args.maxResults || filesScanned >= 5000) break;
      }
    };

    await walk(base);
    return {
      query: args.query,
      matches,
      filesScanned,
      truncated: matches.length >= args.maxResults || filesScanned >= 5000,
    };
  }

  async replace(input: ReplaceArgs, signal?: AbortSignal, expectedHash?: string): Promise<unknown> {
    const args = FsReplaceArgsSchema.parse(input);
    const path = await this.guard.resolvePath(args.path, { mustExist: true });
    const info = await stat(path);
    if (!info.isFile() || info.size > 5_000_000) {
      throw new AppError("INVALID_WRITE_TARGET", "Replacement target must be a file no larger than 5 MB");
    }
    throwIfAborted(signal);
    const beforeBytes = await readFile(path);
    this.verifyHash(beforeBytes, expectedHash);
    const before = beforeBytes.toString("utf8");
    const occurrences = before.split(args.oldText).length - 1;
    if (occurrences !== args.expectedOccurrences) {
      throw new AppError(
        "REPLACE_COUNT_MISMATCH",
        `Expected ${args.expectedOccurrences} occurrence(s), found ${occurrences}`,
        409,
      );
    }
    const after = before.split(args.oldText).join(args.newText);
    await this.atomicOverwrite(path, after, info.mode, expectedHash, signal);
    return { path: apiPath(this.guard.root, path), occurrences, bytes: Buffer.byteLength(after) };
  }

  async write(input: WriteArgs, signal?: AbortSignal, expectedHash?: string): Promise<unknown> {
    const args = FsWriteArgsSchema.parse(input);
    let path = await this.guard.resolvePath(args.path);
    await mkdir(dirname(path), { recursive: true });
    path = await this.guard.resolvePath(args.path);
    throwIfAborted(signal);
    if (!args.overwrite) {
      try {
        await writeFile(path, args.content, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new AppError("FILE_EXISTS", "File exists; set overwrite=true to replace it", 409);
        }
        throw error;
      }
    } else {
      await this.atomicOverwrite(path, args.content, undefined, expectedHash, signal);
    }
    return { path: apiPath(this.guard.root, path), bytes: Buffer.byteLength(args.content) };
  }

  private verifyHash(bytes: Buffer, expectedHash?: string): void {
    if (expectedHash !== undefined && createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
      throw new AppError("SOURCE_CHANGED", "The file changed after it was read. Read the current source and retry the edit.", 409);
    }
  }

  private async atomicOverwrite(path: string, content: string, mode?: number, expectedHash?: string, signal?: AbortSignal): Promise<void> {
    const temporary = join(dirname(path), `.${randomUUID()}.browser-agent.tmp`);
    await this.guard.resolvePath(temporary);
    await writeFile(temporary, content, {
      encoding: "utf8",
      ...(mode === undefined ? {} : { mode }),
    });
    try {
      throwIfAborted(signal);
      const currentPath = await this.guard.resolvePath(path);
      if (currentPath !== path) throw new AppError("SOURCE_CHANGED", "The edit target changed. Read the current source and retry.", 409);
      if (expectedHash !== undefined) this.verifyHash(await readFile(path), expectedHash);
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
