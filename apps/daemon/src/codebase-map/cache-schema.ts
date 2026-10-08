import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  CODEBASE_MAP_CACHE_VERSION,
  CODEBASE_MAP_MAX_EDGES_PER_FILE,
  CODEBASE_MAP_MAX_FILES,
  CODEBASE_MAP_MAX_NODES_PER_FILE,
} from "./constants.js";

const boundedString = (maximum: number) => z.string().max(maximum);
const relativePathSchema = z.string().min(1).max(32_768).refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return !isAbsolute(value)
    && !normalized.includes("\0")
    && normalized.split("/").every((part) => part !== "..");
}, "Expected a repository-relative path without parent traversal");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const idSchema = z.string().min(1).max(256);
const languageSchema = z.enum(["python", "typescript"]);
const nodeKindSchema = z.enum([
  "module",
  "class",
  "interface",
  "function",
  "method",
  "type_alias",
  "variable",
  "enum",
  "test",
]);
const edgeKindSchema = z.enum([
  "CONTAINS",
  "IMPORTS",
  "CALLS",
  "REFERENCES",
  "IMPLEMENTS",
  "EXTENDS",
  "TESTS",
]);
const evidenceSchema = z.enum(["ast_deterministic", "static_heuristic"]);
const pointSchema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
const rangeSchema = z.object({
  start: pointSchema,
  end: pointSchema,
  bytes: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
}).strict();
const nodeSchema = z.object({
  id: idSchema,
  kind: nodeKindSchema,
  language: languageSchema,
  name: boundedString(10_000),
  qualifiedName: boundedString(20_000),
  signature: boundedString(1_000).nullable(),
  file: relativePathSchema,
  range: rangeSchema,
  contentHash: hashSchema,
  parentId: idSchema.nullable(),
  isTest: z.boolean(),
  evidenceClass: evidenceSchema,
  confidence: z.number().min(0).max(1),
}).strict();
const referenceSchema = z.object({
  sourceId: idSchema,
  kind: edgeKindSchema.exclude(["CONTAINS"]),
  targetName: boundedString(20_000),
  targetQualifier: boundedString(20_000).nullable(),
  file: relativePathSchema,
  range: rangeSchema,
  evidenceClass: evidenceSchema,
  confidence: z.number().min(0).max(1),
}).strict();
const diagnosticSchema = z.object({
  severity: z.enum(["warning", "error"]),
  code: boundedString(200),
  message: boundedString(20_000),
  range: rangeSchema.nullable(),
}).strict();
const fileSchema = z.object({
  path: relativePathSchema,
  language: languageSchema,
  contentHash: hashSchema,
  size: z.number().int().nonnegative(),
  modifiedAtMs: z.number().nonnegative(),
  parser: boundedString(200),
  nodes: z.array(nodeSchema).max(CODEBASE_MAP_MAX_NODES_PER_FILE),
  references: z.array(referenceSchema).max(CODEBASE_MAP_MAX_EDGES_PER_FILE),
  diagnostics: z.array(diagnosticSchema).max(100),
}).strict();
const edgeSchema = z.object({
  id: idSchema,
  sourceId: idSchema,
  targetId: idSchema.nullable(),
  targetName: boundedString(20_000),
  kind: edgeKindSchema,
  evidenceClass: evidenceSchema,
  confidence: z.number().min(0).max(1),
  occurrenceCount: z.number().int().positive(),
  evidence: z.object({ file: relativePathSchema, range: rangeSchema }).strict(),
}).strict();
const changeSchema = z.object({
  nodeId: idSchema,
  changeType: z.enum(["added", "modified", "deleted"]),
  file: relativePathSchema,
  kind: nodeKindSchema,
  qualifiedName: boundedString(20_000),
  beforeHash: hashSchema.nullable(),
  afterHash: hashSchema.nullable(),
}).strict();

export const codebaseMapSnapshotSchema = z.object({
  version: z.literal(CODEBASE_MAP_CACHE_VERSION),
  truncated: z.boolean(),
  root: z.string().min(1).max(32_768),
  scanId: z.number().int().nonnegative(),
  revision: hashSchema,
  previousRevision: hashSchema.nullable(),
  completedAt: boundedString(100),
  files: z.array(fileSchema).max(CODEBASE_MAP_MAX_FILES),
  edges: z.array(edgeSchema),
  changes: z.array(changeSchema),
}).strict();
