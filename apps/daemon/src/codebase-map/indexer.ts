import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, join, posix, relative } from "node:path";
import {
  CODEBASE_MAP_LANGUAGES,
  CODEBASE_MAP_MAX_FILES,
  CODEBASE_MAP_MAX_FILE_BYTES,
  CODEBASE_MAP_MAX_TOTAL_BYTES,
  CODEBASE_MAP_SKIPPED_DIRECTORIES,
} from "./constants.js";
import {
  hashText,
  moduleNameForPath,
  normalizeMapPath,
  stableEdgeId,
} from "./identity.js";
import type { TreeSitterCodebaseParser } from "./parser.js";
import { CodebaseMapStore } from "./store.js";
import type {
  CodebaseMapChange,
  CodebaseMapEdge,
  CodebaseMapFile,
  CodebaseMapIndexSummary,
  CodebaseMapNode,
  CodebaseMapReference,
  CodebaseMapRefreshResult,
  CodebaseMapSnapshot,
} from "./types.js";

const PARSER_VERSION = "tree-sitter-wasm/0.25;extractor/1";

interface CandidateFile {
  readonly absolutePath: string;
  readonly path: string;
  readonly language: CodebaseMapFile["language"];
  readonly size: number;
  readonly modifiedAtMs: number;
}

interface DiscoveryResult {
  readonly files: readonly CandidateFile[];
  readonly truncated: boolean;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Codebase mapping cancelled", "AbortError");
}

async function discover(root: string, signal?: AbortSignal): Promise<DiscoveryResult> {
  const files: CandidateFile[] = [];
  let truncated = false;
  let totalBytes = 0;
  let byteBudgetExhausted = false;

  const visit = async (directory: string): Promise<void> => {
    throwIfAborted(signal);
    if (files.length >= CODEBASE_MAP_MAX_FILES || byteBudgetExhausted) {
      truncated = true;
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      if (files.length >= CODEBASE_MAP_MAX_FILES || byteBudgetExhausted) {
        truncated = true;
        break;
      }
      if (CODEBASE_MAP_SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!info.isFile()) continue;
      const language = CODEBASE_MAP_LANGUAGES[extname(entry.name).toLocaleLowerCase()];
      if (!language) continue;
      if (info.size > CODEBASE_MAP_MAX_FILE_BYTES) {
        truncated = true;
        continue;
      }
      if (totalBytes + info.size > CODEBASE_MAP_MAX_TOTAL_BYTES) {
        byteBudgetExhausted = true;
        truncated = true;
        break;
      }
      files.push({
        absolutePath,
        path: normalizeMapPath(relative(root, absolutePath)),
        language,
        size: info.size,
        modifiedAtMs: info.mtimeMs,
      });
      totalBytes += info.size;
    }
  };

  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, truncated };
}

function discoveryFingerprint(discovery: DiscoveryResult): string {
  return hashText(String(discovery.truncated) + "\n" + discovery.files
    .map((file) => `${file.path}\u0000${file.size}\u0000${file.modifiedAtMs}`)
    .join("\n"));
}

function stemForPath(path: string): string {
  const normalized = normalizeMapPath(path);
  const lowered = normalized.toLocaleLowerCase();
  const suffix = [".d.ts", ".pyi", ".tsx", ".mts", ".cts", ".py", ".ts", ".jsx", ".mjs", ".cjs", ".js"]
    .find((candidate) => lowered.endsWith(candidate));
  let stem = suffix ? normalized.slice(0, -suffix.length) : normalized;
  stem = stem.replace(/\/(?:index|__init__)$/, "");
  return stem;
}

function unique<T>(items: readonly T[]): T | null {
  return items.length === 1 ? items[0] ?? null : null;
}

function resolveEdges(files: readonly CodebaseMapFile[]): CodebaseMapEdge[] {
  const nodes = files.flatMap((file) => [...file.nodes]);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byQualified = new Map<string, CodebaseMapNode[]>();
  const bySimple = new Map<string, CodebaseMapNode[]>();
  const modulesByStem = new Map<string, CodebaseMapNode[]>();
  for (const node of nodes) {
    const qualified = node.qualifiedName.toLocaleLowerCase();
    const simple = node.name.toLocaleLowerCase();
    byQualified.set(qualified, [...(byQualified.get(qualified) ?? []), node]);
    bySimple.set(simple, [...(bySimple.get(simple) ?? []), node]);
    if (node.kind === "module") {
      const key = `${node.language}\u0000${stemForPath(node.file).toLocaleLowerCase()}`;
      modulesByStem.set(key, [...(modulesByStem.get(key) ?? []), node]);
    }
  }

  type ResolutionScope = "same_file" | "imported_module" | "qualified_name";
  interface ResolvedTarget {
    readonly node: CodebaseMapNode;
    readonly scope: ResolutionScope;
  }

  const compatible = (
    candidates: readonly CodebaseMapNode[],
    source: CodebaseMapNode,
    sameFile = false,
  ): CodebaseMapNode[] => candidates.filter((candidate) => candidate.language === source.language
    && (!sameFile || candidate.file === source.file));

  const moduleForStem = (source: CodebaseMapNode, stem: string): CodebaseMapNode | null => unique(
    modulesByStem.get(`${source.language}\u0000${stemForPath(stem).toLocaleLowerCase()}`) ?? [],
  );

  const containingClass = (nodeId: string): CodebaseMapNode | null => {
    let current = byId.get(nodeId) ?? null;
    while (current) {
      if (current.kind === "class" || current.kind === "interface") return current;
      current = current.parentId ? byId.get(current.parentId) ?? null : null;
    }
    return null;
  };

  const resolveImport = (reference: CodebaseMapReference): ResolvedTarget | null => {
    const source = byId.get(reference.sourceId);
    if (!source) return null;
    const target = reference.targetName.trim();
    if (!target) return null;
    if (target.startsWith(".")) {
      if (source.language === "python") {
        const dots = /^\.+/.exec(target)?.[0].length ?? 0;
        let directory = posix.dirname(reference.file);
        for (let index = 1; index < dots; index += 1) directory = posix.dirname(directory);
        const remainder = target.slice(dots).replaceAll(".", "/");
        const stem = posix.normalize(posix.join(directory, remainder)).replace(/^\.\//, "");
        const node = moduleForStem(source, stem);
        return node ? { node, scope: "imported_module" } : null;
      }
      const stem = posix.normalize(posix.join(posix.dirname(reference.file), target)).replace(/^\.\//, "");
      const node = moduleForStem(source, stem);
      return node ? { node, scope: "imported_module" } : null;
    }
    if (source.language === "typescript") return null;
    const moduleQualified = unique(compatible(byQualified.get(target.toLocaleLowerCase()) ?? [], source)
      .filter((node) => node.kind === "module"));
    if (moduleQualified) return { node: moduleQualified, scope: "qualified_name" };
    const modulePath = target.replaceAll(".", "/").toLocaleLowerCase();
    const node = moduleForStem(source, modulePath);
    return node ? { node, scope: "imported_module" } : null;
  };

  const importedModulesByFile = new Map<string, CodebaseMapNode[]>();
  for (const reference of files.flatMap((file) => [...file.references])) {
    if (reference.kind !== "IMPORTS") continue;
    const resolved = resolveImport(reference);
    if (!resolved) continue;
    const current = importedModulesByFile.get(reference.file) ?? [];
    if (!current.some((node) => node.id === resolved.node.id)) {
      importedModulesByFile.set(reference.file, [...current, resolved.node]);
    }
  }

  const resolveReference = (reference: CodebaseMapReference): ResolvedTarget | null => {
    if (reference.kind === "IMPORTS") return resolveImport(reference);
    const source = byId.get(reference.sourceId);
    if (!source) return null;
    const target = reference.targetName
      .replaceAll("?.", ".")
      .replace(/<[^<>]*>$/u, "")
      .trim();
    if (!target) return null;
    const exact = unique(compatible(byQualified.get(target.toLocaleLowerCase()) ?? [], source)
      .filter((node) => node.kind !== "module"));
    if (exact) return { node: exact, scope: exact.file === source.file ? "same_file" : "qualified_name" };

    const owner = containingClass(reference.sourceId);
    if (/^(?:self|cls|this)\./.test(target) && owner) {
      const member = target.slice(target.lastIndexOf(".") + 1).toLocaleLowerCase();
      const node = unique(compatible(
        byQualified.get(`${owner.qualifiedName}.${member}`.toLocaleLowerCase()) ?? [],
        source,
        true,
      ));
      return node ? { node, scope: "same_file" } : null;
    }
    if (!target.includes(".") && reference.targetQualifier) {
      const scoped = unique(compatible(
        byQualified.get(`${reference.targetQualifier}.${target}`.toLocaleLowerCase()) ?? [],
        source,
        true,
      ));
      if (scoped) return { node: scoped, scope: "same_file" };
    }

    if (!target.includes(".")) {
      const sameFile = unique(compatible(bySimple.get(target.toLocaleLowerCase()) ?? [], source, true)
        .filter((node) => node.kind !== "module"));
      if (sameFile) return { node: sameFile, scope: "same_file" };
      const imported = unique((importedModulesByFile.get(reference.file) ?? []).flatMap((module) => nodes.filter(
        (node) => node.parentId === module.id && node.name.toLocaleLowerCase() === target.toLocaleLowerCase(),
      )));
      return imported ? { node: imported, scope: "imported_module" } : null;
    }

    if (target.includes(".")) {
      const ownerName = target.slice(0, target.lastIndexOf(".")).toLocaleLowerCase();
      const member = target.slice(target.lastIndexOf(".") + 1).toLocaleLowerCase();
      const sameFileOwners = compatible([
        ...(bySimple.get(ownerName) ?? []),
        ...(byQualified.get(ownerName) ?? []),
      ], source, true).filter((node) => ["class", "interface", "module"].includes(node.kind));
      const importedOwners = (importedModulesByFile.get(reference.file) ?? []).flatMap((module) => nodes.filter(
        (node) => node.parentId === module.id && node.name.toLocaleLowerCase() === ownerName,
      ));
      const sameFileTarget = unique(sameFileOwners.flatMap((candidate) => nodes.filter(
        (node) => node.parentId === candidate.id && node.name.toLocaleLowerCase() === member,
      )));
      if (sameFileTarget) return { node: sameFileTarget, scope: "same_file" };
      const importedTarget = unique(importedOwners.flatMap((candidate) => nodes.filter(
        (node) => node.parentId === candidate.id && node.name.toLocaleLowerCase() === member,
      )));
      if (importedTarget) return { node: importedTarget, scope: "imported_module" };
    }
    return null;
  };

  const edges: CodebaseMapEdge[] = [];
  for (const node of nodes) {
    if (!node.parentId) continue;
    const edgeInput = {
      sourceId: node.parentId,
      kind: "CONTAINS" as const,
      targetId: node.id,
      targetName: node.name,
      file: node.file,
      range: node.range,
    };
    edges.push({
      id: stableEdgeId(edgeInput),
      sourceId: node.parentId,
      targetId: node.id,
      targetName: node.name,
      kind: "CONTAINS",
      evidenceClass: "ast_deterministic",
      confidence: 1,
      occurrenceCount: 1,
      evidence: { file: node.file, range: node.range },
    });
  }

  for (const reference of files.flatMap((file) => [...file.references])) {
    const resolution = resolveReference(reference);
    const target = resolution?.node ?? null;
    let confidence = reference.confidence;
    if (!target) confidence = Math.min(confidence, 0.45);
    else if (reference.kind === "IMPORTS") confidence = Math.max(confidence, 0.95);
    else if (resolution?.scope === "same_file") {
      if (["EXTENDS", "IMPLEMENTS"].includes(reference.kind)) confidence = Math.max(confidence, 0.95);
      else if (reference.kind === "CALLS") confidence = Math.max(confidence, 0.85);
      else if (reference.kind === "TESTS") confidence = Math.max(confidence, 0.75);
    } else if (resolution?.scope === "imported_module") {
      if (["EXTENDS", "IMPLEMENTS"].includes(reference.kind)) confidence = Math.max(confidence, 0.85);
      else if (reference.kind === "CALLS") confidence = Math.max(confidence, 0.7);
      else if (reference.kind === "TESTS") confidence = Math.max(confidence, 0.65);
    } else {
      confidence = Math.min(confidence, 0.8);
    }
    const edgeInput = {
      sourceId: reference.sourceId,
      kind: reference.kind,
      targetId: target?.id ?? null,
      targetName: reference.targetName,
      file: reference.file,
      range: reference.range,
    };
    edges.push({
      id: stableEdgeId(edgeInput),
      sourceId: reference.sourceId,
      targetId: target?.id ?? null,
      targetName: reference.targetName,
      kind: reference.kind,
      evidenceClass: reference.evidenceClass,
      confidence,
      occurrenceCount: 1,
      evidence: { file: reference.file, range: reference.range },
    });
  }

  const aggregated = new Map<string, CodebaseMapEdge>();
  for (const edge of edges) {
    const key = `${edge.sourceId}\u0000${edge.kind}\u0000${edge.targetId ?? edge.targetName}`;
    const existing = aggregated.get(key);
    if (!existing) aggregated.set(key, edge);
    else aggregated.set(key, {
      ...existing,
      confidence: Math.max(existing.confidence, edge.confidence),
      occurrenceCount: existing.occurrenceCount + edge.occurrenceCount,
    });
  }
  return [...aggregated.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function nodeChanges(
  previous: CodebaseMapSnapshot | null,
  files: readonly CodebaseMapFile[],
): CodebaseMapChange[] {
  const before = new Map((previous?.files ?? []).flatMap((file) => file.nodes).map((node) => [node.id, node]));
  const after = new Map(files.flatMap((file) => [...file.nodes]).map((node) => [node.id, node]));
  const changes: CodebaseMapChange[] = [];
  for (const [id, node] of after) {
    const prior = before.get(id);
    if (!prior) {
      changes.push({
        nodeId: id,
        changeType: "added",
        file: node.file,
        kind: node.kind,
        qualifiedName: node.qualifiedName,
        beforeHash: null,
        afterHash: node.contentHash,
      });
    } else if (prior.contentHash !== node.contentHash) {
      changes.push({
        nodeId: id,
        changeType: "modified",
        file: node.file,
        kind: node.kind,
        qualifiedName: node.qualifiedName,
        beforeHash: prior.contentHash,
        afterHash: node.contentHash,
      });
    }
  }
  for (const [id, node] of before) {
    if (after.has(id)) continue;
    changes.push({
      nodeId: id,
      changeType: "deleted",
      file: node.file,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      beforeHash: node.contentHash,
      afterHash: null,
    });
  }
  return changes.sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName) || left.nodeId.localeCompare(right.nodeId));
}

export class CodebaseMapSourceChangedError extends Error {
  constructor() {
    super("Project files changed while the codebase map was being built. Retry the query.");
    this.name = "CodebaseMapSourceChangedError";
  }
}

export class CodebaseMapIndexer {
  constructor(
    private readonly store: CodebaseMapStore,
    private readonly getParser: () => Promise<TreeSitterCodebaseParser>,
  ) {}

  async refresh(root: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<CodebaseMapRefreshResult> {
    const initialDiscovery = await discover(root, options.signal);
    const initialFingerprint = discoveryFingerprint(initialDiscovery);
    const previous = await this.store.load(root);
    const previousFiles = new Map((previous?.files ?? []).map((file) => [file.path, file]));
    const files: CodebaseMapFile[] = [];
    let filesParsed = 0;
    let filesReused = 0;
    let skippedBinaryFile = false;
    let parser: TreeSitterCodebaseParser | undefined;

    for (const candidate of initialDiscovery.files) {
      throwIfAborted(options.signal);
      const content = await readFile(candidate.absolutePath, "utf8");
      if (content.includes("\0")) {
        skippedBinaryFile = true;
        continue;
      }
      const contentHash = hashText(content);
      const prior = previousFiles.get(candidate.path);
      if (!options.force && prior?.contentHash === contentHash && prior.parser === PARSER_VERSION) {
        files.push(prior);
        filesReused += 1;
        continue;
      }
      parser ??= await this.getParser();
      await new Promise<void>((resolve) => setImmediate(resolve));
      throwIfAborted(options.signal);
      files.push(parser.parse({
        path: candidate.path,
        language: candidate.language,
        content,
        contentHash,
        size: candidate.size,
        modifiedAtMs: candidate.modifiedAtMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }));
      filesParsed += 1;
    }

    const finalDiscovery = await discover(root, options.signal);
    if (initialFingerprint !== discoveryFingerprint(finalDiscovery)) throw new CodebaseMapSourceChangedError();
    throwIfAborted(options.signal);
    files.sort((left, right) => left.path.localeCompare(right.path));
    const edges = resolveEdges(files);
    const revision = hashText(files.map((file) => `${file.path}\u0000${file.contentHash}`).join("\n"));
    const changes = nodeChanges(previous, files);
    const snapshot: CodebaseMapSnapshot = {
      version: 1,
      truncated: initialDiscovery.truncated || skippedBinaryFile
        || files.some((file) => file.diagnostics.some((diagnostic) =>
          diagnostic.code === "file_graph_truncated" || diagnostic.severity === "error")),
      root,
      scanId: (previous?.scanId ?? 0) + 1,
      revision,
      previousRevision: previous?.revision ?? null,
      completedAt: new Date().toISOString(),
      files,
      edges,
      changes,
    };
    await this.store.save(snapshot);
    const changeCounts = {
      added: changes.filter((change) => change.changeType === "added").length,
      modified: changes.filter((change) => change.changeType === "modified").length,
      deleted: changes.filter((change) => change.changeType === "deleted").length,
    };
    const previousPaths = new Set((previous?.files ?? []).map((file) => file.path));
    const currentPaths = new Set(files.map((file) => file.path));
    const summary: CodebaseMapIndexSummary = {
      scanId: snapshot.scanId,
      revision,
      completedAt: snapshot.completedAt,
      filesDiscovered: files.length,
      filesParsed,
      filesReused,
      filesDeleted: [...previousPaths].filter((path) => !currentPaths.has(path)).length,
      nodes: files.reduce((total, file) => total + file.nodes.length, 0),
      edges: edges.length,
      diagnostics: files.reduce((total, file) => total + file.diagnostics.length, 0),
      changes: changeCounts,
      truncated: snapshot.truncated,
    };
    return { snapshot, summary };
  }
}
