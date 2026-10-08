import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AppError } from "./errors.js";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

export class WorkspaceGuard {
  private constructor(readonly root: string) {}

  static async create(root: string): Promise<WorkspaceGuard> {
    const canonical = await realpath(resolve(root));
    const info = await stat(canonical);
    if (!info.isDirectory()) {
      throw new AppError("WORKSPACE_NOT_DIRECTORY", "Workspace root is not a directory");
    }
    return new WorkspaceGuard(canonical);
  }

  async resolvePath(input: string, options: { mustExist?: boolean } = {}): Promise<string> {
    if (input.includes("\0")) {
      throw new AppError("INVALID_PATH", "Path contains a null byte");
    }

    const candidate = resolve(this.root, input);
    if (!isWithin(this.root, candidate)) {
      throw new AppError("WORKSPACE_ESCAPE", "Path is outside the selected workspace", 403);
    }

    if (await exists(candidate)) {
      const canonical = await realpath(candidate);
      if (!isWithin(this.root, canonical)) {
        throw new AppError(
          "WORKSPACE_ESCAPE",
          "Path resolves outside the selected workspace",
          403,
        );
      }
      return canonical;
    }

    if (options.mustExist === true) {
      throw new AppError("PATH_NOT_FOUND", "Path does not exist", 404);
    }

    let ancestor = dirname(candidate);
    while (!(await exists(ancestor))) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const canonicalAncestor = await realpath(ancestor);
    if (!isWithin(this.root, canonicalAncestor)) {
      throw new AppError(
        "WORKSPACE_ESCAPE",
        "A parent path resolves outside the selected workspace",
        403,
      );
    }
    return candidate;
  }

  relative(path: string): string {
    if (!isWithin(this.root, path)) {
      throw new AppError("WORKSPACE_ESCAPE", "Path is outside the selected workspace", 403);
    }
    return relative(this.root, path) || ".";
  }
}
