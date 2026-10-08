import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { hashText } from "./identity.js";
import type {
  CodebaseMapEdge,
  CodebaseMapEdgeKind,
  CodebaseMapNode,
  CodebaseMapSnapshot,
} from "./types.js";

function bounded(value: number, fallback: number, maximum: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), maximum) : fallback;
}

function metadata(snapshot: CodebaseMapSnapshot): Record<string, unknown> {
  return {
    scan_id: snapshot.scanId,
    revision: snapshot.revision,
    completed_at: snapshot.completedAt,
    freshness: "indexed_snapshot",
    index_truncated: snapshot.truncated,
    coverage: "supported_files_only",
    diagnostic_count: snapshot.files.reduce((total, file) => total + file.diagnostics.length, 0),
  };
}

type SourceFreshness = "current" | "changed" | "missing" | "outside_repository" | "unreadable";

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function projectNode(node: CodebaseMapNode, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualified_name: node.qualifiedName,
    signature: node.signature,
    language: node.language,
    file: node.file,
    range: node.range,
    content_hash: node.contentHash,
    evidence_class: node.evidenceClass,
    confidence: node.confidence,
    ...extras,
  };
}

function projectEdge(edge: CodebaseMapEdge): Record<string, unknown> {
  return {
    id: edge.id,
    source_id: edge.sourceId,
    target_id: edge.targetId,
    target_name: edge.targetName,
    kind: edge.kind,
    evidence_class: edge.evidenceClass,
    confidence: edge.confidence,
    occurrence_count: edge.occurrenceCount,
    evidence: edge.evidence,
  };
}

export class CodebaseMapSymbolNotFoundError extends Error {
  constructor(symbol: string, incomplete = false) {
    super(`No indexed symbol matches ${JSON.stringify(symbol)}.${incomplete ? " The index is incomplete; search the current source before concluding the symbol is absent." : ""}`);
    this.name = "CodebaseMapSymbolNotFoundError";
  }
}

export class CodebaseMapAmbiguousSymbolError extends Error {
  constructor(symbol: string, candidates: readonly CodebaseMapNode[]) {
    super(`Symbol ${JSON.stringify(symbol)} is ambiguous. Use one of: ${candidates.slice(0, 10).map((node) => node.id).join(", ")}`);
    this.name = "CodebaseMapAmbiguousSymbolError";
  }
}

export class CodebaseMapQueries {
  private readonly nodes: readonly CodebaseMapNode[];
  private readonly nodesById: ReadonlyMap<string, CodebaseMapNode>;
  private readonly outgoing = new Map<string, CodebaseMapEdge[]>();
  private readonly incoming = new Map<string, CodebaseMapEdge[]>();

  constructor(private readonly snapshot: CodebaseMapSnapshot) {
    this.nodes = snapshot.files.flatMap((file) => [...file.nodes]);
    this.nodesById = new Map(this.nodes.map((node) => [node.id, node]));
    for (const edge of snapshot.edges) {
      this.outgoing.set(edge.sourceId, [...(this.outgoing.get(edge.sourceId) ?? []), edge]);
      if (edge.targetId) this.incoming.set(edge.targetId, [...(this.incoming.get(edge.targetId) ?? []), edge]);
    }
  }

  overview(limit = 12): Record<string, unknown> {
    const cap = bounded(limit, 12, 50);
    const countBy = <T extends string>(values: readonly T[]): Array<{ name: T; count: number }> => {
      const counts = new Map<T, number>();
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
      return [...counts].map(([name, count]) => ({ name, count }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
    };
    const ranked = this.nodes
      .filter((node) => ["module", "class", "interface", "function"].includes(node.kind))
      .map((node) => ({
        node,
        score: (this.incoming.get(node.id)?.length ?? 0) + (this.outgoing.get(node.id)?.length ?? 0) * 0.35,
      }))
      .sort((left, right) => right.score - left.score || left.node.qualifiedName.localeCompare(right.node.qualifiedName));
    return {
      map: metadata(this.snapshot),
      files: countBy(this.snapshot.files.map((file) => file.language)).map(({ name, count }) => ({ language: name, count })),
      nodes: countBy(this.nodes.map((node) => node.kind)).map(({ name, count }) => ({ kind: name, count })),
      edges: countBy(this.snapshot.edges.map((edge) => edge.kind)).map(({ name, count }) => ({ kind: name, count })),
      high_value_symbols: ranked.slice(0, cap).map(({ node, score }) => projectNode(node, { score: Number(score.toFixed(3)) })),
      diagnostics: this.snapshot.files.reduce((total, file) => total + file.diagnostics.length, 0),
      unresolved_edges: this.snapshot.edges.filter((edge) => !edge.targetId && edge.kind !== "CONTAINS").length,
      truncated: this.snapshot.truncated || ranked.length > cap,
    };
  }

  findSymbol(query: string, kind?: string, limit = 20): Record<string, unknown> {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) throw new Error("Symbol query must not be empty.");
    const cap = bounded(limit, 20, 200);
    const matches = this.nodes.flatMap((node) => {
      if (kind && node.kind !== kind) return [];
      const name = node.name.toLocaleLowerCase();
      const qualified = node.qualifiedName.toLocaleLowerCase();
      let score = 0;
      if (name === normalized) score = 100;
      else if (qualified === normalized) score = 96;
      else if (name.startsWith(normalized)) score = 82;
      else if (qualified.includes(normalized)) score = 64;
      else return [];
      score += Math.min((this.incoming.get(node.id)?.length ?? 0) + (this.outgoing.get(node.id)?.length ?? 0), 20) * 0.25;
      if (node.kind === "test") score -= 3;
      return [{ node, score }];
    }).sort((left, right) => right.score - left.score || left.node.qualifiedName.localeCompare(right.node.qualifiedName));
    return {
      map: metadata(this.snapshot),
      query,
      items: matches.slice(0, cap).map(({ node, score }) => projectNode(node, { score: Number(score.toFixed(3)) })),
      truncated: this.snapshot.truncated || matches.length > cap,
    };
  }

  traceSymbol(input: {
    symbol: string;
    depth?: number;
    direction?: "in" | "out" | "both";
    edgeKinds?: readonly CodebaseMapEdgeKind[];
    limit?: number;
  }): Record<string, unknown> {
    const center = this.resolveOne(input.symbol);
    const depth = bounded(input.depth ?? 2, 2, 8);
    const limit = bounded(input.limit ?? 50, 50, 200);
    const direction = input.direction ?? "both";
    const kinds = input.edgeKinds?.length ? new Set(input.edgeKinds) : null;
    const maxEdges = Math.min(limit * 4, 500);
    const distances = new Map<string, number>([[center.id, 0]]);
    const selectedEdges = new Map<string, CodebaseMapEdge>();
    const queue = [center.id];
    let truncated = false;
    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      const currentDepth = distances.get(current) ?? 0;
      if (currentDepth >= depth) continue;
      const edges = [
        ...(direction === "out" || direction === "both" ? this.outgoing.get(current) ?? [] : []),
        ...(direction === "in" || direction === "both" ? this.incoming.get(current) ?? [] : []),
      ];
      for (const edge of edges) {
        if (kinds && !kinds.has(edge.kind)) continue;
        const neighbor = edge.sourceId === current ? edge.targetId : edge.sourceId;
        if (neighbor && !distances.has(neighbor)) {
          if (distances.size >= limit || !this.nodesById.has(neighbor)) {
            truncated = true;
            continue;
          }
        }
        if (!selectedEdges.has(edge.id) && selectedEdges.size >= maxEdges) {
          truncated = true;
          queue.length = 0;
          break;
        }
        selectedEdges.set(edge.id, edge);
        if (!neighbor || distances.has(neighbor)) continue;
        distances.set(neighbor, currentDepth + 1);
        queue.push(neighbor);
      }
    }
    const nodes = [...distances].flatMap(([id, distance]) => {
      const node = this.nodesById.get(id);
      return node ? [projectNode(node, { distance })] : [];
    }).sort((left, right) => Number(left.distance) - Number(right.distance)
      || String(left.qualified_name).localeCompare(String(right.qualified_name)));
    return {
      map: metadata(this.snapshot),
      center: projectNode(center),
      nodes,
      edges: [...selectedEdges.values()].sort((left, right) => left.id.localeCompare(right.id)).map(projectEdge),
      truncated: this.snapshot.truncated || truncated,
    };
  }

  impactAnalysis(symbol: string, depth = 3, limit = 50): Record<string, unknown> {
    const center = this.resolveOne(symbol);
    const cap = bounded(limit, 50, 200);
    const maxDepth = bounded(depth, 3, 8);
    const allowed = new Set<CodebaseMapEdgeKind>(["CALLS", "IMPORTS", "REFERENCES", "EXTENDS", "IMPLEMENTS", "TESTS"]);
    const distances = new Map<string, number>();
    const reasons = new Map<string, Set<string>>();
    const queue: Array<{ id: string; depth: number }> = [{ id: center.id, depth: 0 }];
    let truncated = false;
    while (queue.length) {
      const current = queue.shift();
      if (!current || current.depth >= maxDepth) continue;
      for (const edge of this.incoming.get(current.id) ?? []) {
        if (!allowed.has(edge.kind)) continue;
        const nextDepth = current.depth + 1;
        reasons.set(edge.sourceId, new Set([...(reasons.get(edge.sourceId) ?? []), edge.kind]));
        const prior = distances.get(edge.sourceId);
        if (prior !== undefined && prior <= nextDepth) continue;
        if (!distances.has(edge.sourceId) && distances.size >= cap) {
          truncated = true;
          continue;
        }
        distances.set(edge.sourceId, nextDepth);
        queue.push({ id: edge.sourceId, depth: nextDepth });
      }
    }
    const items = [...distances].flatMap(([id, distance]) => {
      const node = this.nodesById.get(id);
      return node ? [projectNode(node, { distance, reasons: [...(reasons.get(id) ?? [])].sort() })] : [];
    }).sort((left, right) => Number(left.distance) - Number(right.distance)
      || Number(right.kind === "test") - Number(left.kind === "test")
      || String(left.qualified_name).localeCompare(String(right.qualified_name)));
    return {
      map: metadata(this.snapshot),
      symbol: projectNode(center),
      items,
      truncated: this.snapshot.truncated || truncated,
    };
  }

  relatedTests(symbol: string, depth = 4, limit = 30): Record<string, unknown> {
    const trace = this.traceSymbol({ symbol, depth, direction: "both", limit: Math.min(bounded(limit, 30, 100) * 6, 200) });
    const cap = bounded(limit, 30, 100);
    const candidates = (trace.nodes as Array<Record<string, unknown>>)
      .filter((node) => node.kind === "test" || /(?:^|[./_])tests?(?:[./_]|$)/i.test(String(node.file)));
    const nodes = candidates.slice(0, cap);
    return {
      map: metadata(this.snapshot),
      symbol: trace.center,
      items: nodes,
      truncated: Boolean(trace.truncated) || candidates.length > cap,
    };
  }

  changedSymbols(limit = 100): Record<string, unknown> {
    const cap = bounded(limit, 100, 500);
    return {
      map: metadata(this.snapshot),
      previous_revision: this.snapshot.previousRevision,
      items: this.snapshot.changes.slice(0, cap).map((change) => ({
        node_id: change.nodeId,
        change_type: change.changeType,
        file: change.file,
        kind: change.kind,
        qualified_name: change.qualifiedName,
        before_hash: change.beforeHash,
        after_hash: change.afterHash,
      })),
      truncated: this.snapshot.truncated || this.snapshot.changes.length > cap,
    };
  }

  semanticContext(symbol: string): Record<string, unknown> {
    const node = this.resolveOne(symbol);
    return {
      map: metadata(this.snapshot),
      symbol: projectNode(node),
      items: [],
      semantic_generation: "disabled",
      note: "The structural map is authoritative for indexed facts. Optional semantic enrichment is not generated automatically.",
      truncated: this.snapshot.truncated,
    };
  }

  async sourceRanges(symbolIds: readonly string[]): Promise<Record<string, unknown>> {
    const ids = [...new Set(symbolIds)];
    const selected = ids.flatMap((id) => {
      const node = this.nodesById.get(id);
      return node ? [node] : [];
    });
    const indexedFiles = new Map(this.snapshot.files.map((file) => [file.path, file]));
    const freshness = new Map<string, SourceFreshness>();
    await Promise.all([...new Set(selected.map((node) => node.file))].map(async (path) => {
      freshness.set(path, await this.sourceFreshness(path, indexedFiles.get(path)?.contentHash ?? null));
    }));
    const items = selected.map((node) => ({
      ...projectNode(node),
      file_content_hash: indexedFiles.get(node.file)?.contentHash ?? null,
      source_freshness: freshness.get(node.file) ?? "unreadable",
    }));
    const missing = ids.filter((id) => !this.nodesById.has(id));
    return {
      map: metadata(this.snapshot),
      items,
      missing_ids: missing,
      authoritative_source_required: true,
      truncated: this.snapshot.truncated,
    };
  }

  private async sourceFreshness(path: string, indexedHash: string | null): Promise<SourceFreshness> {
    if (!indexedHash) return "unreadable";
    try {
      const root = resolve(this.snapshot.root);
      const candidate = resolve(root, path);
      if (!isWithin(root, candidate)) return "outside_repository";
      const [rootReal, info] = await Promise.all([realpath(root), lstat(candidate)]);
      const candidateReal = await realpath(candidate);
      if (!isWithin(rootReal, candidateReal)) return "outside_repository";
      if (!info.isFile() || info.isSymbolicLink()) return "changed";
      return hashText(await readFile(candidate, "utf8")) === indexedHash ? "current" : "changed";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    }
  }

  private resolveOne(symbol: string): CodebaseMapNode {
    const value = symbol.trim().toLocaleLowerCase();
    if (!value) throw new CodebaseMapSymbolNotFoundError(symbol, this.snapshot.truncated);
    const direct = this.nodesById.get(symbol);
    if (direct) return direct;
    const qualified = this.nodes.filter((node) => node.qualifiedName.toLocaleLowerCase() === value);
    if (qualified.length === 1) return qualified[0]!;
    if (qualified.length > 1) throw new CodebaseMapAmbiguousSymbolError(symbol, qualified);
    const simple = this.nodes.filter((node) => node.name.toLocaleLowerCase() === value);
    if (simple.length === 1) return simple[0]!;
    if (simple.length > 1) throw new CodebaseMapAmbiguousSymbolError(symbol, simple);
    throw new CodebaseMapSymbolNotFoundError(symbol, this.snapshot.truncated);
  }
}
