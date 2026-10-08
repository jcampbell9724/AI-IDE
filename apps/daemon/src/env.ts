import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function findRepositoryRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let cursor = resolve(start);
  for (;;) {
    if (existsSync(join(cursor, "pnpm-workspace.yaml"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error("Could not locate repository root (pnpm-workspace.yaml)");
    }
    cursor = parent;
  }
}

export function loadRootEnv(root = findRepositoryRoot()): void {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  process.loadEnvFile(envPath);
}
