import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { sanitizedChildEnvironment, type DaemonRuntime } from "@browser-agent/daemon";
import type { DesktopProjectFile, SaveProjectFileInput } from "../shared/contracts";

type Workspace = Awaited<ReturnType<DaemonRuntime["projects"]["workspace"]>>;
const executeFile = promisify(execFile);
export const PROJECT_FILE_MAX_BYTES = 1_000_000;
export const PROJECT_FILE_MAX_LINES = 5000;
const saveQueues = new Map<string, Promise<unknown>>();

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decode(bytes: Buffer): string {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("This file is not valid UTF-8. Open it in an editor that supports its encoding.");
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(content)) {
    throw new Error("Binary files cannot be shown in the file editor.");
  }
  return content;
}

function normalize(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function lineEnding(content: string): DesktopProjectFile["lineEnding"] {
  const endings = content.match(/\r\n|\r|\n/g) ?? [];
  if (!endings.length || endings.every((ending) => ending === "\n")) return "LF";
  if (endings.every((ending) => ending === "\r\n")) return "CRLF";
  return "mixed";
}

async function readSource(workspace: Workspace, requestedPath: string) {
  const absolutePath = await workspace.resolvePath(requestedPath, { mustExist: true });
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error("Choose a file to view its code.");
  if (info.size > PROJECT_FILE_MAX_BYTES) {
    throw new Error("This file is too large to preview. Open a file no larger than 1 MB.");
  }
  const bytes = await readFile(absolutePath);
  if (bytes.length > PROJECT_FILE_MAX_BYTES) throw new Error("This file is too large to preview.");
  const source = decode(bytes);
  return { absolutePath, info, bytes, source };
}

async function git(root: string, args: string[]): Promise<Buffer> {
  const result = await executeFile("git", ["--no-optional-locks", "--literal-pathspecs", "-C", root, ...args], {
    encoding: "buffer",
    maxBuffer: PROJECT_FILE_MAX_BYTES + 16_384,
    timeout: 3000,
    windowsHide: true,
    env: { ...sanitizedChildEnvironment(), GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout;
}

async function comparison(workspace: Workspace, absolutePath: string): Promise<Pick<DesktopProjectFile, "comparison" | "comparisonError">> {
  try {
    let root: string;
    try {
      root = (await git(workspace.root, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
    } catch (error) {
      const failure = error as { stderr?: Buffer };
      if (failure.stderr?.toString("utf8").includes("not a git repository")) return {};
      throw error;
    }
    const path = relative(root, absolutePath).replaceAll("\\", "/");
    // Looking directly in HEAD includes deleted/staged changes and avoids executing diff drivers.
    let hasHead = true;
    try { await git(root, ["rev-parse", "--verify", "HEAD"]); } catch { hasHead = false; }
    if (!hasHead) return { comparison: { content: "", label: "New file" } };
    const entry = await git(root, ["ls-tree", "-z", "HEAD", "--", path]);
    if (!entry.length) return { comparison: { content: "", label: "New file" } };
    const bytes = await git(root, ["show", `HEAD:${path}`]);
    if (bytes.length > PROJECT_FILE_MAX_BYTES) throw new Error("The saved Git version is too large to compare.");
    const content = normalize(decode(bytes));
    if (content.split("\n").length > PROJECT_FILE_MAX_LINES) throw new Error("The saved Git version has too many lines to compare.");
    return { comparison: { content, label: "HEAD" } };
  } catch {
    return { comparisonError: "Git changes are unavailable. Changes can still be compared with the file when it was opened." };
  }
}

function fileResult(workspace: Workspace, source: Awaited<ReturnType<typeof readSource>>): DesktopProjectFile {
  const lines = normalize(source.source).split("\n");
  return {
    path: workspace.relative(source.absolutePath).replaceAll("\\", "/"),
    projectRoot: workspace.root,
    revision: hash(source.bytes),
    content: lines.slice(0, PROJECT_FILE_MAX_LINES).join("\n"),
    lineEnding: lineEnding(source.source),
    size: source.bytes.length,
    totalLines: lines.length,
    truncated: lines.length > PROJECT_FILE_MAX_LINES,
  };
}

export async function readProjectCodeFile(workspace: Workspace, requestedPath: string): Promise<DesktopProjectFile> {
  const source = await readSource(workspace, requestedPath);
  return { ...fileResult(workspace, source), ...await comparison(workspace, source.absolutePath) };
}

function preserveFormat(content: string, source: string): string {
  let normalized = normalize(content);
  if (source.startsWith("\ufeff") && !normalized.startsWith("\ufeff")) normalized = `\ufeff${normalized}`;
  const endings = source.match(/\r\n|\r|\n/g) ?? [];
  const fallback = lineEnding(source) === "CRLF" ? "\r\n" : endings[0] ?? "\n";
  let index = 0;
  return normalized.replace(/\n/g, () => endings[index++] ?? fallback);
}

async function save(getWorkspace: () => Promise<Workspace>, input: SaveProjectFileInput): Promise<DesktopProjectFile> {
  const workspace = await getWorkspace();
  if (workspace.root !== input.projectRoot) {
    throw new Error("The selected project changed. Reopen this file before saving.");
  }
  const before = await readSource(workspace, input.path);
  if (hash(before.bytes) !== input.revision) {
    throw new Error("This file changed on disk. Reload it and review your changes before saving.");
  }
  if (normalize(before.source).split("\n").length > PROJECT_FILE_MAX_LINES) {
    throw new Error("A truncated preview cannot be saved. Open this file in another editor.");
  }
  const content = preserveFormat(input.content, before.source);
  const bytes = Buffer.from(content, "utf8");
  if (decode(bytes) !== content) throw new Error("The edited content contains invalid text.");
  if (bytes.length > PROJECT_FILE_MAX_BYTES || normalize(content).split("\n").length > PROJECT_FILE_MAX_LINES) {
    throw new Error("The edited file exceeds the 1 MB or 5,000 line limit.");
  }
  const temporary = join(dirname(before.absolutePath), `.span-editor-${randomUUID()}.tmp`);
  await workspace.resolvePath(temporary);
  let temporaryCreated = false;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: before.info.mode });
    temporaryCreated = true;
    const currentWorkspace = await getWorkspace();
    if (currentWorkspace.root !== input.projectRoot) {
      throw new Error("The selected project changed. Reopen this file before saving.");
    }
    const current = await readSource(currentWorkspace, input.path);
    if (current.absolutePath !== before.absolutePath || hash(current.bytes) !== input.revision) {
      throw new Error("This file changed on disk. Reload it and review your changes before saving.");
    }
    if (await currentWorkspace.resolvePath(temporary, { mustExist: true }) !== temporary) {
      throw new Error("The file location changed. Reopen it before saving.");
    }
    await rename(temporary, before.absolutePath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => undefined);
  }
  // Build the result from the committed bytes so an immediate external edit cannot mask a conflict.
  const committed = { ...before, bytes, source: content };
  return { ...fileResult(workspace, committed), ...await comparison(workspace, before.absolutePath) };
}

export async function saveProjectCodeFile(getWorkspace: () => Promise<Workspace>, input: SaveProjectFileInput): Promise<DesktopProjectFile> {
  const key = `${input.projectRoot}\0${input.path}`;
  const previous = saveQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(() => save(getWorkspace, input));
  saveQueues.set(key, result);
  try { return await result; } finally {
    if (saveQueues.get(key) === result) saveQueues.delete(key);
  }
}
