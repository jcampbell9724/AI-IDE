import { createRequire } from "node:module";
import { dirname } from "node:path";
import { z } from "zod";
import { CODEBASE_MAP_TOOL_NAME, CODEBASE_MAP_VALIDATION_TTL_MS } from "./constants.js";
import { CodebaseMapIndexer } from "./indexer.js";
import type { TreeSitterCodebaseParser } from "./parser.js";
import { CodebaseMapQueries } from "./queries.js";
import { CodebaseMapStore } from "./store.js";
import type {
  CodebaseMapEdgeKind,
  CodebaseMapIndexSummary,
  CodebaseMapSnapshot,
} from "./types.js";

const edgeKindSchema = z.enum([
  "CONTAINS",
  "IMPORTS",
  "CALLS",
  "REFERENCES",
  "IMPLEMENTS",
  "EXTENDS",
  "TESTS",
]);

const codebaseMapInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("project_overview"), limit: z.number().int().min(1).max(50).default(12) }).strict(),
  z.object({
    action: z.literal("find_symbol"),
    query: z.string().trim().min(1).max(1000),
    kind: z.string().trim().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(200).default(20),
  }).strict(),
  z.object({
    action: z.literal("trace_symbol"),
    symbol: z.string().trim().min(1).max(2000),
    depth: z.number().int().min(1).max(8).default(2),
    direction: z.enum(["in", "out", "both"]).default("both"),
    edgeKinds: z.array(edgeKindSchema).max(7).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }).strict(),
  z.object({
    action: z.literal("impact_analysis"),
    symbol: z.string().trim().min(1).max(2000),
    depth: z.number().int().min(1).max(8).default(3),
    limit: z.number().int().min(1).max(200).default(50),
  }).strict(),
  z.object({
    action: z.literal("related_tests"),
    symbol: z.string().trim().min(1).max(2000),
    depth: z.number().int().min(1).max(8).default(4),
    limit: z.number().int().min(1).max(100).default(30),
  }).strict(),
  z.object({ action: z.literal("changed_symbols"), limit: z.number().int().min(1).max(500).default(100) }).strict(),
  z.object({ action: z.literal("semantic_context"), symbol: z.string().trim().min(1).max(2000) }).strict(),
  z.object({
    action: z.literal("source_ranges"),
    symbolIds: z.array(z.string().trim().min(1).max(2000)).min(1).max(100),
  }).strict(),
  z.object({ action: z.literal("refresh_index") }).strict(),
]);

export type CodebaseMapToolInput = z.infer<typeof codebaseMapInputSchema>;

export interface CodebaseMapToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export const CODEBASE_MAP_TOOL: CodebaseMapToolDefinition = {
  type: "function",
  function: {
    name: CODEBASE_MAP_TOOL_NAME,
    description: [
      "Query the optional persistent structural map of the selected project.",
      "Use it for compact navigation before broad filesystem searches.",
      "Its ranges are pointers, not source substitutes: inspect exact source before consequential edits.",
      "Respect evidence_class, confidence, unresolved targets, freshness, and truncation.",
      "Actions: project_overview, find_symbol, trace_symbol, impact_analysis, related_tests, changed_symbols, semantic_context, source_ranges, refresh_index.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "project_overview",
            "find_symbol",
            "trace_symbol",
            "impact_analysis",
            "related_tests",
            "changed_symbols",
            "semantic_context",
            "source_ranges",
            "refresh_index",
          ],
        },
        query: { type: "string", description: "Symbol search text for find_symbol." },
        symbol: { type: "string", description: "A stable node id, qualified name, or unique symbol name." },
        symbolIds: { type: "array", items: { type: "string" }, maxItems: 100 },
        kind: { type: "string", description: "Optional node-kind filter for find_symbol." },
        depth: { type: "integer", minimum: 1, maximum: 8 },
        direction: { type: "string", enum: ["in", "out", "both"] },
        edgeKinds: { type: "array", items: { type: "string", enum: edgeKindSchema.options }, maxItems: 7 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};

export const CODEBASE_MAP_AGENT_INSTRUCTION = [
  "A persistent structural codebase map is available through codebase_map.",
  "Prefer it for initial orientation, symbol tracing, impact analysis, related tests, and changed-symbol discovery.",
  "Treat indexed ranges as navigation pointers and verify exact source before edits.",
  "When map.index_truncated is true, empty results are incomplete: search current source before concluding a symbol or dependency is absent.",
].join(" ");

export interface CodebaseMapFeatureOptions {
  readonly cacheDirectory: string;
  readonly enabled?: boolean;
  readonly wasmDirectory?: string;
}

interface ActiveRefresh {
  readonly controller: AbortController;
  promise: Promise<CodebaseMapSnapshot>;
  waiters: number;
  settled: boolean;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Codebase mapping cancelled", "AbortError");
}

function defaultWasmDirectory(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@vscode/tree-sitter-wasm"));
}

export class CodebaseMapFeature {
  private enabledState: boolean;
  private settingsVersionState = 0;
  private readonly store: CodebaseMapStore;
  private readonly indexer: CodebaseMapIndexer;
  private parser: TreeSitterCodebaseParser | undefined;
  private parserPromise: Promise<TreeSitterCodebaseParser> | undefined;
  private readonly snapshots = new Map<string, CodebaseMapSnapshot>();
  private readonly summaries = new Map<string, CodebaseMapIndexSummary>();
  private readonly validatedAt = new Map<string, number>();
  private readonly refreshes = new Map<string, ActiveRefresh>();

  constructor(private readonly options: CodebaseMapFeatureOptions) {
    this.enabledState = options.enabled ?? false;
    this.store = new CodebaseMapStore(options.cacheDirectory);
    this.indexer = new CodebaseMapIndexer(this.store, () => this.loadParser());
  }

  get enabled(): boolean {
    return this.enabledState;
  }

  get settingsVersion(): number { return this.settingsVersionState; }

  setEnabled(enabled: boolean): void {
    if (enabled !== this.enabledState) this.settingsVersionState += 1;
    this.enabledState = enabled;
  }

  definitions(enabled = this.enabledState): readonly CodebaseMapToolDefinition[] {
    return enabled ? [CODEBASE_MAP_TOOL] : [];
  }

  invalidate(root?: string): void {
    if (root) this.validatedAt.delete(root);
    else this.validatedAt.clear();
  }

  async execute(rawInput: unknown, root: string, signal?: AbortSignal): Promise<unknown> {
    const input = codebaseMapInputSchema.parse(rawInput);
    if (input.action === "refresh_index") {
      const snapshot = await this.refresh(root, signal);
      return {
        map: {
          scan_id: snapshot.scanId,
          revision: snapshot.revision,
          completed_at: snapshot.completedAt,
          freshness: "indexed_snapshot",
        },
        ...this.summaries.get(root),
      };
    }
    const snapshot = await this.ensureFresh(root, signal);
    const queries = new CodebaseMapQueries(snapshot);
    switch (input.action) {
      case "project_overview":
        return queries.overview(input.limit);
      case "find_symbol":
        return queries.findSymbol(input.query, input.kind, input.limit);
      case "trace_symbol":
        return queries.traceSymbol({
          symbol: input.symbol,
          depth: input.depth,
          direction: input.direction,
          ...(input.edgeKinds === undefined ? {} : { edgeKinds: input.edgeKinds as readonly CodebaseMapEdgeKind[] }),
          limit: input.limit,
        });
      case "impact_analysis":
        return queries.impactAnalysis(input.symbol, input.depth, input.limit);
      case "related_tests":
        return queries.relatedTests(input.symbol, input.depth, input.limit);
      case "changed_symbols":
        return queries.changedSymbols(input.limit);
      case "semantic_context":
        return queries.semanticContext(input.symbol);
      case "source_ranges":
        return queries.sourceRanges(input.symbolIds);
    }
  }

  dispose(): void {
    for (const refresh of this.refreshes.values()) {
      refresh.controller.abort(new DOMException("Codebase mapping stopped", "AbortError"));
    }
    this.refreshes.clear();
    this.parser?.dispose();
    this.parser = undefined;
    this.parserPromise = undefined;
    this.snapshots.clear();
    this.summaries.clear();
    this.validatedAt.clear();
  }

  private async ensureFresh(root: string, signal?: AbortSignal): Promise<CodebaseMapSnapshot> {
    const current = this.snapshots.get(root);
    const checkedAt = this.validatedAt.get(root) ?? 0;
    if (current && Date.now() - checkedAt < CODEBASE_MAP_VALIDATION_TTL_MS) return current;
    return this.refresh(root, signal);
  }

  private async refresh(root: string, signal?: AbortSignal): Promise<CodebaseMapSnapshot> {
    if (signal?.aborted) throw abortReason(signal);
    const existing = this.refreshes.get(root);
    if (existing) return this.awaitRefresh(existing, signal);
    const controller = new AbortController();
    const active = {
      controller,
      waiters: 0,
      settled: false,
    } as ActiveRefresh;
    active.promise = this.indexer.refresh(root, {
      signal: controller.signal,
    }).then(({ snapshot, summary }) => {
      this.snapshots.set(root, snapshot);
      this.summaries.set(root, summary);
      this.validatedAt.set(root, Date.now());
      return snapshot;
    }).finally(() => {
      active.settled = true;
      if (this.refreshes.get(root) === active) this.refreshes.delete(root);
    });
    this.refreshes.set(root, active);
    return this.awaitRefresh(active, signal);
  }

  private async awaitRefresh(active: ActiveRefresh, signal?: AbortSignal): Promise<CodebaseMapSnapshot> {
    if (signal?.aborted) throw abortReason(signal);
    active.waiters += 1;
    try {
      if (!signal) return await active.promise;
      return await new Promise<CodebaseMapSnapshot>((resolve, reject) => {
        let finished = false;
        const settle = (callback: () => void): void => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = (): void => settle(() => reject(abortReason(signal)));
        signal.addEventListener("abort", onAbort, { once: true });
        active.promise.then(
          (snapshot) => settle(() => resolve(snapshot)),
          (error: unknown) => settle(() => reject(error)),
        );
      });
    } finally {
      active.waiters -= 1;
      if (!active.settled && active.waiters === 0) {
        active.controller.abort(new DOMException("Codebase mapping cancelled", "AbortError"));
      }
    }
  }

  private loadParser(): Promise<TreeSitterCodebaseParser> {
    this.parserPromise ??= import("./parser.js")
      .then(({ TreeSitterCodebaseParser }) => TreeSitterCodebaseParser.create(
        this.options.wasmDirectory ?? defaultWasmDirectory(),
      ))
      .then((parser) => {
        this.parser = parser;
        return parser;
      });
    return this.parserPromise;
  }
}
