export const CODEBASE_MAP_TOOL_NAME = "codebase_map";

export const CODEBASE_MAP_CACHE_VERSION = 1 as const;
export const CODEBASE_MAP_MAX_FILES = 10_000;
export const CODEBASE_MAP_MAX_FILE_BYTES = 2_000_000;
export const CODEBASE_MAP_MAX_TOTAL_BYTES = 100_000_000;
export const CODEBASE_MAP_MAX_NODES_PER_FILE = 2_000;
export const CODEBASE_MAP_MAX_EDGES_PER_FILE = 5_000;
export const CODEBASE_MAP_VALIDATION_TTL_MS = 2_000;

export const CODEBASE_MAP_SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".ai-map",
  ".cache",
  ".next",
  ".nuxt",
  ".pnpm-store",
  ".pytest_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

export const CODEBASE_MAP_LANGUAGES: Readonly<Record<string, "python" | "typescript">> = {
  ".cjs": "typescript",
  ".cts": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".mts": "typescript",
  ".py": "python",
  ".pyi": "python",
  ".ts": "typescript",
  ".tsx": "typescript",
};
