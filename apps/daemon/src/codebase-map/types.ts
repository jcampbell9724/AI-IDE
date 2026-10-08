export type CodebaseMapLanguage = "python" | "typescript";

export type CodebaseMapNodeKind =
  | "module"
  | "class"
  | "interface"
  | "function"
  | "method"
  | "type_alias"
  | "variable"
  | "enum"
  | "test";

export type CodebaseMapEdgeKind =
  | "CONTAINS"
  | "IMPORTS"
  | "CALLS"
  | "REFERENCES"
  | "IMPLEMENTS"
  | "EXTENDS"
  | "TESTS";

export interface CodebaseMapRange {
  readonly start: readonly [line: number, column: number];
  readonly end: readonly [line: number, column: number];
  readonly bytes: readonly [start: number, end: number];
}

export interface CodebaseMapNode {
  readonly id: string;
  readonly kind: CodebaseMapNodeKind;
  readonly language: CodebaseMapLanguage;
  readonly name: string;
  readonly qualifiedName: string;
  readonly signature: string | null;
  readonly file: string;
  readonly range: CodebaseMapRange;
  readonly contentHash: string;
  readonly parentId: string | null;
  readonly isTest: boolean;
  readonly evidenceClass: "ast_deterministic" | "static_heuristic";
  readonly confidence: number;
}

export interface CodebaseMapReference {
  readonly sourceId: string;
  readonly kind: Exclude<CodebaseMapEdgeKind, "CONTAINS">;
  readonly targetName: string;
  readonly targetQualifier: string | null;
  readonly file: string;
  readonly range: CodebaseMapRange;
  readonly evidenceClass: "ast_deterministic" | "static_heuristic";
  readonly confidence: number;
}

export interface CodebaseMapEdge {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string | null;
  readonly targetName: string;
  readonly kind: CodebaseMapEdgeKind;
  readonly evidenceClass: "ast_deterministic" | "static_heuristic";
  readonly confidence: number;
  readonly occurrenceCount: number;
  readonly evidence: {
    readonly file: string;
    readonly range: CodebaseMapRange;
  };
}

export interface CodebaseMapDiagnostic {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly range: CodebaseMapRange | null;
}

export interface CodebaseMapFile {
  readonly path: string;
  readonly language: CodebaseMapLanguage;
  readonly contentHash: string;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly parser: string;
  readonly nodes: readonly CodebaseMapNode[];
  readonly references: readonly CodebaseMapReference[];
  readonly diagnostics: readonly CodebaseMapDiagnostic[];
}

export interface CodebaseMapChange {
  readonly nodeId: string;
  readonly changeType: "added" | "modified" | "deleted";
  readonly file: string;
  readonly kind: CodebaseMapNodeKind;
  readonly qualifiedName: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}

export interface CodebaseMapSnapshot {
  readonly version: 1;
  readonly truncated: boolean;
  readonly root: string;
  readonly scanId: number;
  readonly revision: string;
  readonly previousRevision: string | null;
  readonly completedAt: string;
  readonly files: readonly CodebaseMapFile[];
  readonly edges: readonly CodebaseMapEdge[];
  readonly changes: readonly CodebaseMapChange[];
}

export interface CodebaseMapIndexSummary {
  readonly scanId: number;
  readonly revision: string;
  readonly completedAt: string;
  readonly filesDiscovered: number;
  readonly filesParsed: number;
  readonly filesReused: number;
  readonly filesDeleted: number;
  readonly nodes: number;
  readonly edges: number;
  readonly diagnostics: number;
  readonly changes: {
    readonly added: number;
    readonly modified: number;
    readonly deleted: number;
  };
  readonly truncated: boolean;
}

export interface CodebaseMapRefreshResult {
  readonly snapshot: CodebaseMapSnapshot;
  readonly summary: CodebaseMapIndexSummary;
}
