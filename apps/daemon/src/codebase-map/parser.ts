import { join } from "node:path";
import treeSitter from "@vscode/tree-sitter-wasm";
import type {
  Node as SyntaxNode,
  Parser as TreeSitterParser,
  Tree,
} from "@vscode/tree-sitter-wasm";
import {
  CODEBASE_MAP_MAX_EDGES_PER_FILE,
  CODEBASE_MAP_MAX_NODES_PER_FILE,
} from "./constants.js";
import { hashText, moduleNameForPath, stableNodeId } from "./identity.js";
import type {
  CodebaseMapDiagnostic,
  CodebaseMapFile,
  CodebaseMapLanguage,
  CodebaseMapNode,
  CodebaseMapNodeKind,
  CodebaseMapRange,
  CodebaseMapReference,
} from "./types.js";

const PYTHON_DEFINITIONS = new Set([
  "class_definition",
  "function_definition",
  "type_alias_statement",
]);
const TYPESCRIPT_CONTAINERS: Readonly<Record<string, CodebaseMapNodeKind>> = {
  abstract_class_declaration: "class",
  class_declaration: "class",
  enum_declaration: "enum",
  interface_declaration: "interface",
  internal_module: "module",
};
const TYPESCRIPT_FUNCTIONS = new Set([
  "abstract_method_signature",
  "function_declaration",
  "function_signature",
  "generator_function_declaration",
  "method_definition",
  "method_signature",
]);
const TEST_FACTORIES = new Set(["describe", "it", "test"]);
const TEST_MODIFIERS = new Set(["concurrent", "each", "only", "skip", "todo"]);

let runtimeInitialization: Promise<void> | undefined;
const { Language, Parser } = treeSitter;

function child(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName(field);
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((candidate): candidate is SyntaxNode => candidate !== null);
}

function sameNode(left: SyntaxNode | null, right: SyntaxNode | null): boolean {
  return Boolean(left && right && left.equals(right));
}

function sourceRange(node: SyntaxNode): CodebaseMapRange {
  return {
    start: [node.startPosition.row + 1, node.startPosition.column + 1],
    end: [node.endPosition.row + 1, node.endPosition.column + 1],
    bytes: [node.startIndex, node.endIndex],
  };
}

function normalizedSignature(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 1000) : null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ["'", '"', "`"].includes(trimmed[0] ?? "")
      && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function looksLikeTestFile(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLocaleLowerCase();
  const name = normalized.split("/").at(-1) ?? normalized;
  return normalized.includes("/tests/")
    || normalized.includes("/__tests__/")
    || name.startsWith("test_")
    || name.endsWith("_test.py")
    || name.includes(".test.")
    || name.includes(".spec.");
}

function headerText(node: SyntaxNode): string {
  const body = child(node, "body");
  if (!body) return node.text;
  const offset = node.text.indexOf(body.text);
  return offset < 0 ? node.text : node.text.slice(0, offset);
}

function assignmentHeader(node: SyntaxNode): string {
  const value = child(node, "right") ?? child(node, "value");
  if (!value) return node.text;
  const offset = node.text.indexOf(value.text);
  return (offset < 0 ? node.text : node.text.slice(0, offset)).replace(/[=:\s]+$/, "");
}

function walk(root: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    result.push(current);
    stack.push(...namedChildren(current).reverse());
  }
  return result;
}

function staticString(node: SyntaxNode | null): string | null {
  if (!node || !["string", "template_string"].includes(node.type)) return null;
  if (node.type === "template_string" && node.text.includes("${")) return null;
  return unquote(node.text);
}

interface ExtractedFile {
  readonly nodes: readonly CodebaseMapNode[];
  readonly references: readonly CodebaseMapReference[];
  readonly diagnostics: readonly CodebaseMapDiagnostic[];
}

class Extractor {
  private readonly nodes: CodebaseMapNode[] = [];
  private readonly references: CodebaseMapReference[] = [];
  private readonly diagnostics: CodebaseMapDiagnostic[] = [];
  private readonly ids = new Set<string>();
  private readonly duplicateCounts = new Map<string, number>();
  private readonly isTestFile: boolean;
  private module!: CodebaseMapNode;
  private limitDiagnosticAdded = false;

  constructor(
    private readonly language: CodebaseMapLanguage,
    private readonly path: string,
  ) {
    this.isTestFile = looksLikeTestFile(path);
  }

  extract(root: SyntaxNode): ExtractedFile {
    const moduleName = moduleNameForPath(this.path);
    this.module = this.newNode(root, {
      kind: "module",
      name: moduleName.split(".").at(-1) ?? moduleName,
      qualifiedName: moduleName,
      signature: null,
      parent: null,
      isTest: this.isTestFile,
    });
    for (const current of namedChildren(root)) this.visit(current, this.module, null);
    this.collectSyntaxDiagnostics(root);
    return {
      nodes: this.nodes,
      references: this.references,
      diagnostics: this.diagnostics,
    };
  }

  private visit(node: SyntaxNode, parent: CodebaseMapNode, containingClass: CodebaseMapNode | null): void {
    if (this.language === "python") {
      if (PYTHON_DEFINITIONS.has(node.type)) {
        this.visitPythonDefinition(node, parent, containingClass);
        return;
      }
      if (node.type === "assignment" && this.visitPythonAssignment(node, parent, containingClass)) return;
      if (["import_statement", "import_from_statement", "future_import_statement"].includes(node.type)) {
        this.pythonImport(node);
      }
      if (node.type === "call") this.callReference(node, parent, containingClass, false);
    } else {
      const containerKind = TYPESCRIPT_CONTAINERS[node.type];
      if (containerKind) {
        this.visitTypeScriptContainer(node, parent, containingClass, containerKind);
        return;
      }
      if (TYPESCRIPT_FUNCTIONS.has(node.type)) {
        this.visitTypeScriptFunction(node, parent, containingClass);
        return;
      }
      if (node.type === "type_alias_declaration") {
        this.visitTypeScriptTypeAlias(node, parent, containingClass);
        return;
      }
      if (node.type === "variable_declarator" && this.visitTypeScriptVariable(node, parent, containingClass)) return;
      if (["public_field_definition", "property_signature"].includes(node.type)) {
        this.visitTypeScriptField(node, parent, containingClass);
        return;
      }
      if (node.type === "import_statement") this.typeScriptImport(node);
      else if (node.type === "export_statement" && child(node, "source")) this.typeScriptImport(node);
      if (node.type === "call_expression") {
        if (this.visitTypeScriptTestCall(node, parent, containingClass)) return;
        this.callReference(node, parent, containingClass, false);
      } else if (node.type === "new_expression") {
        this.callReference(node, parent, containingClass, true);
      }
    }
    for (const current of namedChildren(node)) this.visit(current, parent, containingClass);
  }

  private visitPythonDefinition(
    node: SyntaxNode,
    parent: CodebaseMapNode,
    containingClass: CodebaseMapNode | null,
  ): void {
    const nameNode = child(node, "name") ?? walk(node).find((candidate) => candidate.type === "identifier") ?? null;
    if (!nameNode) return;
    const name = nameNode.text;
    let kind: CodebaseMapNodeKind;
    let isTest = false;
    if (node.type === "class_definition") {
      kind = "class";
      isTest = this.isTestFile && name.startsWith("Test");
    } else if (node.type === "type_alias_statement") {
      kind = "type_alias";
    } else {
      isTest = this.isTestFile && name.startsWith("test_");
      kind = isTest ? "test" : parent.kind === "class" ? "method" : "function";
    }
    const span = this.declarationWrapper(node);
    const record = this.newNode(span, {
      kind,
      name,
      qualifiedName: this.childName(parent, name),
      signature: headerText(node),
      parent,
      isTest,
    });
    if (node.type === "class_definition") {
      const superclasses = child(node, "superclasses");
      for (const base of superclasses ? namedChildren(superclasses) : []) {
        if (base.type !== "keyword_argument") this.reference(record, "EXTENDS", base, record, 0.9, "ast_deterministic");
      }
    }
    const body = child(node, "body");
    for (const current of namedChildren(node)) {
      if (sameNode(current, body)) {
        this.visit(current, record, node.type === "class_definition" ? record : containingClass);
      } else if (!sameNode(current, nameNode)) {
        this.visit(current, parent, containingClass);
      }
    }
  }

  private visitPythonAssignment(
    node: SyntaxNode,
    parent: CodebaseMapNode,
    containingClass: CodebaseMapNode | null,
  ): boolean {
    if (!["module", "class"].includes(parent.kind)) return false;
    const left = child(node, "left");
    if (!left || left.type !== "identifier") return false;
    const annotation = child(node, "type");
    const kind: CodebaseMapNodeKind = annotation?.text.endsWith("TypeAlias") ? "type_alias" : "variable";
    const record = this.newNode(node, {
      kind,
      name: left.text,
      qualifiedName: this.childName(parent, left.text),
      signature: assignmentHeader(node),
      parent,
      isTest: false,
    });
    const value = child(node, "right");
    for (const current of namedChildren(node)) {
      if (!sameNode(current, left) && !sameNode(current, annotation)) {
        this.visit(current, sameNode(current, value) ? record : parent, containingClass);
      }
    }
    return true;
  }

  private visitTypeScriptContainer(
    node: SyntaxNode,
    parent: CodebaseMapNode,
    containingClass: CodebaseMapNode | null,
    kind: CodebaseMapNodeKind,
  ): void {
    const nameNode = child(node, "name");
    const name = nameNode?.text || "default";
    const record = this.newNode(this.declarationWrapper(node), {
      kind,
      name,
      qualifiedName: this.childName(parent, name),
      signature: headerText(node),
      parent,
      isTest: false,
    });
    this.typeScriptHeritage(node, record);
    const body = child(node, "body");
    for (const current of namedChildren(node)) {
      if (sameNode(current, body)) {
        this.visit(current, record, ["class", "interface"].includes(kind) ? record : containingClass);
      } else if (!sameNode(current, nameNode)) {
        this.visit(current, parent, containingClass);
      }
    }
  }

  private visitTypeScriptFunction(
    node: SyntaxNode,
    parent: CodebaseMapNode,
    containingClass: CodebaseMapNode | null,
  ): void {
    const nameNode = child(node, "name");
    const name = nameNode?.text || "default";
    const method = ["method_definition", "method_signature", "abstract_method_signature"].includes(node.type)
      || ["class", "interface"].includes(parent.kind);
    const record = this.newNode(this.declarationWrapper(node), {
      kind: method ? "method" : "function",
      name,
      qualifiedName: this.childName(parent, name),
      signature: headerText(node),
      parent,
      isTest: false,
    });
    const body = child(node, "body");
    for (const current of namedChildren(node)) {
      if (sameNode(current, body)) this.visit(current, record, containingClass);
      else if (!sameNode(current, nameNode)) this.visit(current, parent, containingClass);
    }
  }

  private visitTypeScriptTypeAlias(
    node: SyntaxNode,
    parent: CodebaseMapNode,
    containingClass: CodebaseMapNode | null,
  ): void {
    const nameNode = child(node, "name");
    if (!nameNode) return;
    this.newNode(this.declarationWrapper(node), {
      kind: "type_alias",
      name: nameNode.text,
      qualifiedName: this.childName(parent, nameNode.text),
      signature: node.text,
      parent,
      isTest: false,
    });
    for (const current of namedChildren(node)) {
      if (!sameNode(current, nameNode)) this.visit(current, parent, containingClass);
    }
  }

  private visitTypeScriptVariable(
    node: SyntaxNode,
    parent: CodebaseMapNode,
    containingClass: CodebaseMapNode | null,
  ): boolean {
    if (!["module", "class"].includes(parent.kind)) return false;
    const nameNode = child(node, "name");
    if (!nameNode || !["identifier", "property_identifier"].includes(nameNode.type)) return false;
    const value = child(node, "value");
    const callable = Boolean(value && ["arrow_function", "function_expression"].includes(value.type));
    const record = this.newNode(node, {
      kind: callable ? (parent.kind === "class" ? "method" : "function") : "variable",
      name: nameNode.text,
      qualifiedName: this.childName(parent, nameNode.text),
      signature: callable && value ? `${assignmentHeader(node)} ${headerText(value)}` : assignmentHeader(node),
      parent,
      isTest: false,
    });
    for (const current of namedChildren(node)) {
      if (!sameNode(current, nameNode)) this.visit(current, callable && sameNode(current, value) ? record : parent, containingClass);
    }
    return true;
  }

  private visitTypeScriptField(
    node: SyntaxNode,
    parent: CodebaseMapNode,
    containingClass: CodebaseMapNode | null,
  ): void {
    const nameNode = child(node, "name");
    if (!nameNode) return;
    const value = child(node, "value");
    const callable = Boolean(value && ["arrow_function", "function_expression"].includes(value.type));
    const record = this.newNode(node, {
      kind: callable ? "method" : "variable",
      name: nameNode.text,
      qualifiedName: this.childName(parent, nameNode.text),
      signature: callable && value ? `${assignmentHeader(node)} ${headerText(value)}` : assignmentHeader(node),
      parent,
      isTest: false,
    });
    if (value) this.visit(value, callable ? record : parent, containingClass);
  }

  private visitTypeScriptTestCall(
    node: SyntaxNode,
    parent: CodebaseMapNode,
    containingClass: CodebaseMapNode | null,
  ): boolean {
    const functionNode = child(node, "function");
    if (!functionNode) return false;
    const parts = functionNode.text.split(".");
    const factory = parts.shift() ?? "";
    if (!TEST_FACTORIES.has(factory) || parts.some((part) => !TEST_MODIFIERS.has(part.replace(/\(.*/, "")))) return false;
    if (factory === "describe") return false;
    const args = child(node, "arguments");
    const children = args ? namedChildren(args) : [];
    const title = staticString(children[0] ?? null) ?? "unnamed";
    const record = this.newNode(node, {
      kind: "test",
      name: title,
      qualifiedName: this.childName(parent, `${factory}:${title}`),
      signature: `${functionNode.text}(${JSON.stringify(title)})`,
      parent,
      isTest: true,
    });
    for (const current of children.slice(1)) this.visit(current, record, containingClass);
    return true;
  }

  private pythonImport(node: SyntaxNode): void {
    if (node.type === "import_statement") {
      for (const current of namedChildren(node)) {
        const name = current.type === "aliased_import" ? child(current, "name")?.text : current.text;
        if (name) this.reference(this.module, "IMPORTS", current, null, 1, "ast_deterministic", name);
      }
      return;
    }
    const module = child(node, "module_name") ?? child(node, "module");
    if (module) this.reference(this.module, "IMPORTS", module, null, 1, "ast_deterministic", unquote(module.text));
  }

  private typeScriptImport(node: SyntaxNode): void {
    const source = child(node, "source");
    const module = staticString(source);
    if (source && module) this.reference(this.module, "IMPORTS", source, null, 1, "ast_deterministic", module);
  }

  private typeScriptHeritage(node: SyntaxNode, source: CodebaseMapNode): void {
    const body = child(node, "body");
    for (const header of namedChildren(node)) {
      if (sameNode(header, body)) continue;
      for (const current of walk(header)) {
        if (["extends_clause", "extends_type_clause"].includes(current.type)) {
          const value = child(current, "value");
          for (const target of value ? [value] : namedChildren(current)) {
            this.reference(source, "EXTENDS", target, source, 0.9, "ast_deterministic");
          }
        } else if (current.type === "implements_clause") {
          for (const target of namedChildren(current)) {
            this.reference(source, "IMPLEMENTS", target, source, 0.9, "ast_deterministic");
          }
        }
      }
    }
  }

  private callReference(
    node: SyntaxNode,
    source: CodebaseMapNode,
    containingClass: CodebaseMapNode | null,
    constructor: boolean,
  ): void {
    const target = child(node, constructor ? "constructor" : "function");
    if (target) this.reference(source, "CALLS", target, containingClass, 0.55, "static_heuristic");
  }

  private reference(
    source: CodebaseMapNode,
    kind: CodebaseMapReference["kind"],
    target: SyntaxNode,
    containingClass: CodebaseMapNode | null,
    confidence: number,
    evidenceClass: CodebaseMapReference["evidenceClass"],
    targetOverride?: string,
  ): void {
    if (this.references.length >= CODEBASE_MAP_MAX_EDGES_PER_FILE) {
      this.addLimitDiagnostic();
      return;
    }
    const targetName = (targetOverride ?? target.text).trim().replaceAll("?.", ".");
    if (!targetName) return;
    const targetQualifier = containingClass?.qualifiedName
      ?? (targetName.includes(".") ? targetName.slice(0, targetName.lastIndexOf(".")) : null);
    this.references.push({
      sourceId: source.id,
      kind,
      targetName,
      targetQualifier,
      file: this.path,
      range: sourceRange(target),
      evidenceClass,
      confidence,
    });
    if (kind === "CALLS" && source.isTest && this.references.length < CODEBASE_MAP_MAX_EDGES_PER_FILE) {
      this.references.push({
        sourceId: source.id,
        kind: "TESTS",
        targetName,
        targetQualifier,
        file: this.path,
        range: sourceRange(target),
        evidenceClass: "static_heuristic",
        confidence: 0.5,
      });
    }
  }

  private newNode(
    span: SyntaxNode,
    input: {
      readonly kind: CodebaseMapNodeKind;
      readonly name: string;
      readonly qualifiedName: string;
      readonly signature: string | null;
      readonly parent: CodebaseMapNode | null;
      readonly isTest: boolean;
    },
  ): CodebaseMapNode {
    const signature = normalizedSignature(input.signature);
    const duplicateKey = `${input.kind}\u0000${input.qualifiedName}\u0000${signature ?? ""}`;
    const occurrence = (this.duplicateCounts.get(duplicateKey) ?? 0) + 1;
    this.duplicateCounts.set(duplicateKey, occurrence);
    const qualifiedName = occurrence === 1 ? input.qualifiedName : `${input.qualifiedName}@${occurrence}`;
    const id = stableNodeId({
      language: this.language,
      file: this.path,
      kind: input.kind,
      qualifiedName,
      signature,
    });
    const record: CodebaseMapNode = {
      id,
      kind: input.kind,
      language: this.language,
      name: input.name,
      qualifiedName,
      signature,
      file: this.path,
      range: sourceRange(span),
      contentHash: hashText(span.text),
      parentId: input.parent?.id ?? null,
      isTest: input.isTest,
      evidenceClass: "ast_deterministic",
      confidence: 1,
    };
    if (this.nodes.length < CODEBASE_MAP_MAX_NODES_PER_FILE && !this.ids.has(record.id)) {
      this.nodes.push(record);
      this.ids.add(record.id);
    } else {
      this.addLimitDiagnostic();
    }
    return record;
  }

  private declarationWrapper(node: SyntaxNode): SyntaxNode {
    const parent = node.parent;
    if (parent && ["decorated_definition", "export_statement"].includes(parent.type)) {
      const declaration = child(parent, "definition") ?? child(parent, "declaration");
      if (sameNode(declaration, node)) return parent;
    }
    if (parent && ["lexical_declaration", "variable_declaration"].includes(parent.type)) {
      const grandparent = parent.parent;
      if (grandparent?.type === "export_statement") return grandparent;
    }
    return node;
  }

  private childName(parent: CodebaseMapNode, name: string): string {
    return parent.qualifiedName ? `${parent.qualifiedName}.${name}` : name;
  }

  private collectSyntaxDiagnostics(root: SyntaxNode): void {
    if (!root.hasError) return;
    for (const current of walk(root)) {
      if (!current.isError && !current.isMissing) continue;
      this.diagnostics.push({
        severity: "error",
        code: current.isMissing ? "missing_syntax" : "syntax_error",
        message: current.isMissing
          ? `Tree-sitter expected ${current.type}`
          : "Tree-sitter encountered malformed syntax",
        range: sourceRange(current),
      });
      if (this.diagnostics.length >= 20) {
        this.diagnostics.push({
          severity: "warning",
          code: "syntax_diagnostics_truncated",
          message: "Syntax diagnostics were limited to 20 entries.",
          range: null,
        });
        break;
      }
    }
  }

  private addLimitDiagnostic(): void {
    if (this.limitDiagnosticAdded) return;
    this.limitDiagnosticAdded = true;
    this.diagnostics.push({
      severity: "warning",
      code: "file_graph_truncated",
      message: "This file exceeded the bounded node or relationship limit.",
      range: null,
    });
  }
}

export class TreeSitterCodebaseParser {
  private constructor(
    private readonly parsers: Readonly<Record<"python" | "typescript" | "tsx", TreeSitterParser>>,
  ) {}

  static async create(wasmDirectory: string): Promise<TreeSitterCodebaseParser> {
    runtimeInitialization ??= Parser.init({
      locateFile: (file) => join(wasmDirectory, file),
    });
    await runtimeInitialization;
    const [python, typescript, tsx] = await Promise.all([
      Language.load(join(wasmDirectory, "tree-sitter-python.wasm")),
      Language.load(join(wasmDirectory, "tree-sitter-typescript.wasm")),
      Language.load(join(wasmDirectory, "tree-sitter-tsx.wasm")),
    ]);
    const pythonParser = new Parser().setLanguage(python);
    const typeScriptParser = new Parser().setLanguage(typescript);
    const tsxParser = new Parser().setLanguage(tsx);
    return new TreeSitterCodebaseParser({
      python: pythonParser,
      typescript: typeScriptParser,
      tsx: tsxParser,
    });
  }

  parse(input: {
    readonly path: string;
    readonly language: CodebaseMapLanguage;
    readonly content: string;
    readonly contentHash: string;
    readonly size: number;
    readonly modifiedAtMs: number;
    readonly signal?: AbortSignal;
  }): CodebaseMapFile {
    const lowerPath = input.path.toLocaleLowerCase();
    const parser = lowerPath.endsWith(".tsx") || lowerPath.endsWith(".jsx")
      ? this.parsers.tsx
      : this.parsers[input.language];
    let tree: Tree | null = null;
    try {
      tree = parser.parse(input.content, null, {
        progressCallback: () => input.signal?.aborted ?? false,
      });
      if (!tree) {
        if (input.signal?.aborted) {
          throw input.signal.reason instanceof Error
            ? input.signal.reason
            : new DOMException("Indexing cancelled", "AbortError");
        }
        throw new Error("Tree-sitter did not return a syntax tree.");
      }
      const extracted = new Extractor(input.language, input.path).extract(tree.rootNode);
      return {
        path: input.path,
        language: input.language,
        contentHash: input.contentHash,
        size: input.size,
        modifiedAtMs: input.modifiedAtMs,
        parser: "tree-sitter-wasm/0.25;extractor/1",
        nodes: extracted.nodes,
        references: extracted.references,
        diagnostics: extracted.diagnostics,
      };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      return {
        path: input.path,
        language: input.language,
        contentHash: input.contentHash,
        size: input.size,
        modifiedAtMs: input.modifiedAtMs,
        parser: "tree-sitter-wasm/0.25;extractor/1",
        nodes: [],
        references: [],
        diagnostics: [{
          severity: "error",
          code: "parser_failure",
          message: `Tree-sitter extraction failed: ${error instanceof Error ? error.message : String(error)}`,
          range: null,
        }],
      };
    } finally {
      tree?.delete();
      parser.reset();
    }
  }

  dispose(): void {
    this.parsers.python.delete();
    this.parsers.typescript.delete();
    this.parsers.tsx.delete();
  }
}
