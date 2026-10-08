import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CodebaseMapFeature } from "./feature.js";
import { shortHash, stableEdgeId } from "./identity.js";
import { CodebaseMapStore } from "./store.js";

const temporaryDirectories: string[] = [];

function wasmDirectory(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@vscode/tree-sitter-wasm"));
}

async function fixture(): Promise<{ root: string; cache: string }> {
  const root = await mkdtemp(join(tmpdir(), "browser-agent-code-map-project-"));
  const cache = await mkdtemp(join(tmpdir(), "browser-agent-code-map-cache-"));
  temporaryDirectories.push(root, cache);
  await writeFile(join(root, "service.ts"), [
    "export class UserService extends BaseService {",
    "  save(): void { helper(); }",
    "}",
    "export function helper(): string { return 'ok'; }",
    "",
  ].join("\n"));
  await writeFile(join(root, "service.test.ts"), [
    "import { UserService } from './service';",
    "test('saves a user', () => { new UserService().save(); });",
    "",
  ].join("\n"));
  await writeFile(join(root, "worker.py"), [
    "from service import helper",
    "class Worker(BaseWorker):",
    "    def run(self):",
    "        return helper()",
    "",
  ].join("\n"));
  return { root, cache };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CodebaseMapFeature", () => {
  it("keeps incomplete-index metadata on empty queries and after cache reload", async () => {
    const { root, cache } = await fixture();
    await writeFile(join(root, "large.ts"), Array.from({ length: 2002 }, (_, index) => `export function fn${index}() { return ${index}; }`).join("\n"));
    const feature = new CodebaseMapFeature({ cacheDirectory: cache, wasmDirectory: wasmDirectory(), enabled: true });
    try {
      expect(await feature.execute({ action: "refresh_index" }, root)).toMatchObject({ truncated: true });
      expect(await feature.execute({ action: "find_symbol", query: "fn2001" }, root))
        .toMatchObject({ items: [], truncated: true, map: { index_truncated: true } });
      expect(await new CodebaseMapStore(cache).load(root)).toMatchObject({ truncated: true });
      await expect(feature.execute({ action: "trace_symbol", symbol: "fn2001" }, root)).rejects.toThrow("index is incomplete");
    } finally {
      feature.dispose();
    }
    const reloaded = new CodebaseMapFeature({ cacheDirectory: cache, wasmDirectory: wasmDirectory(), enabled: true });
    try {
      expect(await reloaded.execute({ action: "find_symbol", query: "fn2001" }, root))
        .toMatchObject({ items: [], truncated: true, map: { index_truncated: true } });
    } finally {
      reloaded.dispose();
    }
  });

  it("reports skipped oversized source files as an incomplete index", async () => {
    const { root, cache } = await fixture();
    await writeFile(join(root, "oversized.ts"), " ".repeat(2_000_001));
    const feature = new CodebaseMapFeature({ cacheDirectory: cache, wasmDirectory: wasmDirectory(), enabled: true });
    try {
      expect(await feature.execute({ action: "find_symbol", query: "absent" }, root))
        .toMatchObject({ items: [], truncated: true, map: { index_truncated: true } });
    } finally {
      feature.dispose();
    }
  });
  it("is opt-in and exposes one compact model tool only while enabled", async () => {
    const { cache } = await fixture();
    const feature = new CodebaseMapFeature({ cacheDirectory: cache, wasmDirectory: wasmDirectory() });
    expect(feature.enabled).toBe(false);
    expect(feature.definitions()).toEqual([]);

    feature.setEnabled(true);
    expect(feature.definitions()).toHaveLength(1);
    expect(feature.definitions()[0]?.function.name).toBe("codebase_map");
    feature.setEnabled(false);
    expect(feature.definitions()).toEqual([]);
    await expect(feature.execute({ action: "refresh_index", force: true }, cache)).rejects.toThrow();
    feature.dispose();
  });

  it("indexes Python, TypeScript, and tests, then reuses an unchanged snapshot", async () => {
    const { root, cache } = await fixture();
    const feature = new CodebaseMapFeature({
      cacheDirectory: cache,
      wasmDirectory: wasmDirectory(),
      enabled: true,
    });

    const overview = await feature.execute({ action: "project_overview", limit: 20 }, root) as {
      files: Array<{ language: string; count: number }>;
      high_value_symbols: Array<{ qualified_name: string }>;
      unresolved_edges: number;
    };
    expect(overview.files).toEqual(expect.arrayContaining([
      { language: "typescript", count: 2 },
      { language: "python", count: 1 },
    ]));
    expect(overview.high_value_symbols.some((node) => node.qualified_name.endsWith("UserService"))).toBe(true);
    expect(overview.unresolved_edges).toBeGreaterThan(0);

    const found = await feature.execute({ action: "find_symbol", query: "UserService", limit: 10 }, root) as {
      items: Array<{ id: string; qualified_name: string }>;
    };
    expect(found.items[0]?.qualified_name).toMatch(/UserService$/);

    const refresh = await feature.execute({ action: "refresh_index" }, root) as {
      filesParsed: number;
      filesReused: number;
    };
    expect(refresh.filesParsed).toBe(0);
    expect(refresh.filesReused).toBe(3);

    const ranges = await feature.execute({
      action: "source_ranges",
      symbolIds: [found.items[0]!.id],
    }, root) as {
      authoritative_source_required: boolean;
      items: Array<{ file: string; range: { start: [number, number] }; source_freshness: string }>;
    };
    expect(ranges.items[0]).toMatchObject({ file: "service.ts" });
    expect(ranges.items[0]?.range.start[0]).toBeGreaterThan(0);
    expect(ranges.items[0]?.source_freshness).toBe("current");
    expect(ranges.authoritative_source_required).toBe(true);

    await writeFile(join(root, "service.ts"), "export class UserService {}\n");
    const staleRanges = await feature.execute({
      action: "source_ranges",
      symbolIds: [found.items[0]!.id],
    }, root) as { items: Array<{ source_freshness: string }> };
    expect(staleRanges.items[0]?.source_freshness).toBe("changed");
    feature.dispose();
  });

  it("resolves imported TypeScript symbols but does not cross-link an unrelated language", async () => {
    const { root, cache } = await fixture();
    const feature = new CodebaseMapFeature({
      cacheDirectory: cache,
      wasmDirectory: wasmDirectory(),
      enabled: true,
    });

    const found = await feature.execute({ action: "find_symbol", query: "UserService" }, root) as {
      items: Array<{ id: string }>;
    };
    const related = await feature.execute({
      action: "related_tests",
      symbol: found.items[0]!.id,
    }, root) as { items: Array<{ name: string }> };
    expect(related.items.map((item) => item.name)).toContain("saves a user");

    const pythonTrace = await feature.execute({
      action: "trace_symbol",
      symbol: "worker.Worker.run",
      direction: "out",
      edgeKinds: ["CALLS"],
      depth: 1,
    }, root) as { edges: Array<{ target_id: string | null; target_name: string; confidence: number }> };
    const helperCall = pythonTrace.edges.find((edge) => edge.target_name === "helper");
    expect(helperCall).toMatchObject({ target_id: null });
    expect(helperCall?.confidence).toBeLessThanOrEqual(0.45);
    feature.dispose();
  });

  it("parses JSX with the TSX grammar", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-agent-code-map-jsx-project-"));
    const cache = await mkdtemp(join(tmpdir(), "browser-agent-code-map-jsx-cache-"));
    temporaryDirectories.push(root, cache);
    await writeFile(join(root, "view.jsx"), [
      "export function View() {",
      "  return <section>Hello</section>;",
      "}",
      "",
    ].join("\n"));
    const feature = new CodebaseMapFeature({
      cacheDirectory: cache,
      wasmDirectory: wasmDirectory(),
      enabled: true,
    });

    const overview = await feature.execute({ action: "project_overview" }, root) as { diagnostics: number };
    const found = await feature.execute({ action: "find_symbol", query: "View", kind: "function" }, root) as { items: unknown[] };
    expect(overview.diagnostics).toBe(0);
    expect(found.items).toHaveLength(1);
    feature.dispose();
  });

  it("keeps trace output within the documented relationship cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-agent-code-map-bounds-project-"));
    const cache = await mkdtemp(join(tmpdir(), "browser-agent-code-map-bounds-cache-"));
    temporaryDirectories.push(root, cache);
    const targets = Array.from({ length: 550 }, (_, index) => `target${index}`);
    await writeFile(join(root, "many.ts"), [
      `export function hub(): void { ${targets.map((name) => `${name}();`).join(" ")} }`,
      ...targets.map((name) => `export function ${name}(): void {}`),
      "",
    ].join("\n"));
    const feature = new CodebaseMapFeature({
      cacheDirectory: cache,
      wasmDirectory: wasmDirectory(),
      enabled: true,
    });

    const trace = await feature.execute({
      action: "trace_symbol",
      symbol: "many.hub",
      direction: "out",
      edgeKinds: ["CALLS"],
      depth: 1,
      limit: 200,
    }, root) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ source_id: string; target_id: string | null }>;
      truncated: boolean;
    };
    expect(trace.edges.length).toBeLessThanOrEqual(500);
    expect(trace.truncated).toBe(true);
    const returnedNodeIds = new Set(trace.nodes.map((node) => node.id));
    for (const edge of trace.edges) {
      expect(returnedNodeIds.has(edge.source_id)).toBe(true);
      if (edge.target_id) expect(returnedNodeIds.has(edge.target_id)).toBe(true);
    }
    feature.dispose();
  });

  it("lets one caller cancel without aborting another caller's shared refresh", async () => {
    const { root, cache } = await fixture();
    const feature = new CodebaseMapFeature({
      cacheDirectory: cache,
      wasmDirectory: wasmDirectory(),
      enabled: true,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = feature.execute({ action: "project_overview" }, root, firstController.signal);
    const second = feature.execute({ action: "project_overview" }, root, secondController.signal);
    firstController.abort(new DOMException("First caller stopped", "AbortError"));

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({ map: { freshness: "indexed_snapshot" } });
    feature.dispose();
  });

  it("records body-only symbol changes without forcing unchanged files to reparse", async () => {
    const { root, cache } = await fixture();
    const feature = new CodebaseMapFeature({
      cacheDirectory: cache,
      wasmDirectory: wasmDirectory(),
      enabled: true,
    });
    await feature.execute({ action: "project_overview" }, root);
    await writeFile(join(root, "service.ts"), [
      "export class UserService extends BaseService {",
      "  save(): void { helper(); helper(); }",
      "}",
      "export function helper(): string { return 'changed'; }",
      "",
    ].join("\n"));
    feature.invalidate(root);

    const refresh = await feature.execute({ action: "refresh_index" }, root) as {
      filesParsed: number;
      filesReused: number;
      changes: { modified: number };
    };
    expect(refresh.filesParsed).toBe(1);
    expect(refresh.filesReused).toBe(2);
    expect(refresh.changes.modified).toBeGreaterThan(0);

    const changes = await feature.execute({ action: "changed_symbols", limit: 100 }, root) as {
      items: Array<{ change_type: string; qualified_name: string }>;
    };
    expect(changes.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ change_type: "modified", qualified_name: expect.stringMatching(/helper$/) }),
    ]));
    feature.dispose();
  });

  it("rebuilds safely when a local cache is structurally corrupt", async () => {
    const { root, cache } = await fixture();
    const first = new CodebaseMapFeature({
      cacheDirectory: cache,
      wasmDirectory: wasmDirectory(),
      enabled: true,
    });
    await first.execute({ action: "project_overview" }, root);
    first.dispose();
    await writeFile(join(cache, "v1", shortHash(root), "map.json"), JSON.stringify({
      version: 1,
      root,
      scanId: 1,
      revision: "not-a-valid-revision",
      previousRevision: null,
      completedAt: new Date().toISOString(),
      files: [null],
      edges: [],
      changes: [],
    }));

    const recovered = new CodebaseMapFeature({
      cacheDirectory: cache,
      wasmDirectory: wasmDirectory(),
      enabled: true,
    });
    await expect(recovered.execute({ action: "project_overview" }, root)).resolves.toMatchObject({
      files: expect.arrayContaining([{ language: "typescript", count: 2 }]),
    });
    recovered.dispose();
  });

  it("keeps reference-edge identity stable across resolution and line movement", () => {
    const base = {
      sourceId: "source",
      kind: "CALLS" as const,
      targetId: "first-target",
      targetName: "helper",
      file: "src/service.ts",
      range: { start: [1, 1], end: [1, 7], bytes: [0, 6] } as const,
    };
    expect(stableEdgeId(base)).toBe(stableEdgeId({
      ...base,
      targetId: "replacement-target",
      range: { start: [40, 3], end: [40, 9], bytes: [900, 906] },
    }));
    expect(stableEdgeId(base)).not.toBe(stableEdgeId({ ...base, targetName: "other" }));
  });
});
