import { createHash } from "node:crypto";
import { extname } from "node:path";
import type {
  CodebaseMapEdgeKind,
  CodebaseMapLanguage,
  CodebaseMapNodeKind,
  CodebaseMapRange,
} from "./types.js";

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 24);
}

export function normalizeMapPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized || ".";
}

export function moduleNameForPath(path: string): string {
  const normalized = normalizeMapPath(path);
  const lowered = normalized.toLocaleLowerCase();
  const compoundExtension = [".d.ts", ".pyi", ".tsx", ".mts", ".cts", ".py", ".ts", ".jsx", ".mjs", ".cjs", ".js"]
    .find((candidate) => lowered.endsWith(candidate));
  const extension = compoundExtension ?? extname(normalized);
  let stem = extension ? normalized.slice(0, -extension.length) : normalized;
  stem = stem.replace(/\/(?:index|__init__)$/, "");
  return stem.replaceAll("/", ".") || normalized;
}

export function stableNodeId(input: {
  language: CodebaseMapLanguage;
  file: string;
  kind: CodebaseMapNodeKind;
  qualifiedName: string;
  signature: string | null;
}): string {
  const identity = [
    input.language,
    normalizeMapPath(input.file).toLocaleLowerCase(),
    input.kind,
    input.qualifiedName,
    input.signature ?? "",
  ].join("\u0000");
  return `node_${shortHash(identity)}`;
}

export function stableEdgeId(input: {
  sourceId: string;
  kind: CodebaseMapEdgeKind;
  targetId: string | null;
  targetName: string;
  file: string;
  range: CodebaseMapRange;
}): string {
  const targetKey = input.kind === "CONTAINS"
    ? input.targetId ?? input.targetName
    : input.targetName;
  const identity = [
    input.sourceId,
    input.kind,
    targetKey,
    normalizeMapPath(input.file).toLocaleLowerCase(),
  ].join("\u0000");
  return `edge_${shortHash(identity)}`;
}

export function rangeFromOffsets(
  text: string,
  start: number,
  end: number,
): CodebaseMapRange {
  const safeStart = Math.max(0, Math.min(start, text.length));
  const safeEnd = Math.max(safeStart, Math.min(end, text.length));
  const startPrefix = text.slice(0, safeStart);
  const endPrefix = text.slice(0, safeEnd);
  const startLines = startPrefix.split(/\r?\n/);
  const endLines = endPrefix.split(/\r?\n/);
  return {
    start: [startLines.length, (startLines.at(-1)?.length ?? 0) + 1],
    end: [endLines.length, (endLines.at(-1)?.length ?? 0) + 1],
    bytes: [Buffer.byteLength(text.slice(0, safeStart)), Buffer.byteLength(text.slice(0, safeEnd))],
  };
}
