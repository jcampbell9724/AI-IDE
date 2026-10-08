import { readdir, readFile, stat } from "node:fs/promises";
import { basename, posix } from "node:path";
import type { ProjectDetection } from "@browser-agent/shared";
import { AppError } from "./errors.js";
import { WorkspaceGuard } from "./workspace-guard.js";
import { detectBackend } from "./backend-detection.js";

const lockfiles: ReadonlyArray<readonly [string, string]> = [
  ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"],
  ["bun.lock", "bun"], ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"],
];
const frameworkPackages: Record<string, string> = {
  next: "next", react: "react", vue: "vue", svelte: "svelte", "@sveltejs/kit": "sveltekit",
  "@angular/core": "angular", vite: "vite", astro: "astro", remix: "remix",
  "@remix-run/react": "remix", "@remix-run/dev": "remix", nuxt: "nuxt",
  express: "express", fastify: "fastify", "@nestjs/core": "nestjs",
};
const ignoredDirectories = new Set([
  "node_modules", "vendor", "dist", "build", "coverage", "target", "out",
  "venv", "__pycache__", "fixtures", "__fixtures__", "test", "tests", "examples",
]);

async function fileExists(guard: WorkspaceGuard, path: string): Promise<boolean> {
  try {
    return (await stat(await guard.resolvePath(path, { mustExist: true }))).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function declaredPackageManager(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(npm|pnpm|yarn|bun)@/i.exec(value.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

interface NodeProject {
  directory: string;
  manifests: string[];
  packageManager: string;
  scripts: Record<string, string>;
  frameworks: string[];
  commands: ProjectDetection["suggestedCommands"];
}

async function packageManagerFiles(guard: WorkspaceGuard, directory: string) {
  const matches = await Promise.all(lockfiles.map(async ([file, manager]) => {
    const path = posix.join(directory, file);
    return await fileExists(guard, path) ? { path, manager } : undefined;
  }));
  return matches.filter((match) => match !== undefined);
}

async function readNodeProject(
  guard: WorkspaceGuard,
  directory: string,
  inheritedManager: string | null,
): Promise<NodeProject | undefined> {
  const manifest = posix.join(directory, "package.json");
  if (!(await fileExists(guard, manifest))) return undefined;
  let parsed: Record<string, unknown>;
  try {
    const raw = await readFile(await guard.resolvePath(manifest, { mustExist: true }), "utf8");
    const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!isRecord(value)) throw new Error("The root value is not an object");
    parsed = value;
  } catch {
    throw new AppError(
      "INVALID_PROJECT_MANIFEST",
      `${manifest} is not valid JSON. Fix it before starting this project.`,
    );
  }
  const scripts = isRecord(parsed.scripts) ? Object.fromEntries(
    Object.entries(parsed.scripts).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].trim().length > 0 && entry[1].length <= 4096),
  ) : {};
  const dependencies = {
    ...(isRecord(parsed.dependencies) ? parsed.dependencies : {}),
    ...(isRecord(parsed.devDependencies) ? parsed.devDependencies : {}),
    ...(isRecord(parsed.peerDependencies) ? parsed.peerDependencies : {}),
  };
  const files = await packageManagerFiles(guard, directory);
  const packageManager = declaredPackageManager(parsed.packageManager)
    ?? files[0]?.manager ?? inheritedManager ?? "npm";
  const commands: ProjectDetection["suggestedCommands"] = {};
  // Only generate paths accepted by both the structured parser and Windows shims.
  const safeDirectory = /^[\p{L}\p{N}_ .\/@+-]*$/u.test(directory);
  if (safeDirectory) {
    const directoryFlag = packageManager === "npm" ? "--prefix" : packageManager === "pnpm" ? "--dir" : "--cwd";
    const manager = directory ? `${packageManager} ${directoryFlag} "./${directory}"` : packageManager;
    for (const [kind, names] of Object.entries({
      dev: ["dev", "start:dev", "dev:start", "develop", "serve", "dev:server"],
      start: ["start"], test: ["test"], build: ["build"],
    })) {
      const name = names.find((candidate) => Object.hasOwn(scripts, candidate));
      if (name) commands[kind as keyof typeof commands] = `${manager} run ${name}`;
    }
  }
  return {
    directory, scripts, packageManager, commands,
    manifests: [manifest, ...files.map((file) => file.path)],
    frameworks: [...new Set(Object.entries(frameworkPackages)
      .filter(([dependency]) => Object.hasOwn(dependencies, dependency))
      .map(([, framework]) => framework))],
  };
}

async function nestedNodeProjects(guard: WorkspaceGuard, inheritedManager: string | null) {
  const projects: NodeProject[] = [];
  const manifests: string[] = [];
  const queue = [{ directory: "", depth: 0 }];
  let visited = 0;
  let complete = true;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (++visited > 80 || projects.length >= 20) { complete = false; break; }
    let entries;
    try {
      entries = await readdir(await guard.resolvePath(current.directory || ".", { mustExist: true }), { withFileTypes: true });
    } catch { complete = false; continue; }
    if (current.directory && entries.some((entry) => entry.name === "package.json" && entry.isFile())) {
      manifests.push(posix.join(current.directory, "package.json"));
      try {
        const project = await readNodeProject(guard, current.directory, inheritedManager);
        if (project) projects.push(project);
      } catch {
        // Keep discovery metadata, but do not silently choose a sibling of a broken app.
        complete = false;
      }
      // Package contents are not independent project candidates.
      continue;
    }
    if (current.depth >= 3) continue;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".") || ignoredDirectories.has(entry.name)) continue;
      queue.push({ directory: posix.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return { projects, manifests, complete };
}

export async function detectProject(rootInput: string): Promise<ProjectDetection> {
  const guard = await WorkspaceGuard.create(rootInput);
  const root = guard.root;
  const manifests: string[] = [];
  const runtimes = new Set<string>();
  const frameworks = new Set<string>();
  const rootLocks = await packageManagerFiles(guard, "");
  manifests.push(...rootLocks.map((file) => file.path));
  let packageManager = rootLocks[0]?.manager ?? null;
  if (await fileExists(guard, "pnpm-workspace.yaml")) {
    manifests.push("pnpm-workspace.yaml");
    packageManager ??= "pnpm";
  }
  let scripts: Record<string, string> = {};
  const suggestedCommands: ProjectDetection["suggestedCommands"] = {};
  const rootEntries = await readdir(root, { withFileTypes: true });
  for (const entry of rootEntries.filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20)) {
    if (await fileExists(guard, entry.name)) manifests.push(entry.name);
  }
  const nodeProject = await readNodeProject(guard, "", packageManager);
  if (nodeProject) {
    manifests.push(...nodeProject.manifests);
    runtimes.add("node");
    nodeProject.frameworks.forEach((framework) => frameworks.add(framework));
    packageManager = nodeProject.packageManager;
    scripts = nodeProject.scripts;
    Object.assign(suggestedCommands, nodeProject.commands);
  }

  for (const file of ["pyproject.toml", "requirements.txt", "manage.py", "app.py", "main.py", "server.py"]) {
    if (await fileExists(guard, file)) {
      manifests.push(file);
      runtimes.add("python");
    }
  }
  if (await fileExists(guard, "manage.py")) {
    frameworks.add("django");
    if (!suggestedCommands.start) suggestedCommands.dev ??= "python manage.py runserver";
  }
  const backend = await detectBackend(guard);
  if (backend) {
    runtimes.add(backend.runtime);
    if (backend.framework) frameworks.add(backend.framework);
    if (!suggestedCommands.start) suggestedCommands.dev ??= backend.command;
  }
  if (await fileExists(guard, "Cargo.toml")) {
    manifests.push("Cargo.toml");
    runtimes.add("rust");
    const cargo = await readFile(await guard.resolvePath("Cargo.toml", { mustExist: true }), "utf8");
    if (!suggestedCommands.start && (await fileExists(guard, "src/main.rs") || /^\s*\[\[bin\]\]/m.test(cargo))) {
      suggestedCommands.dev ??= "cargo run";
    }
    suggestedCommands.test ??= "cargo test";
    suggestedCommands.build ??= "cargo build";
  }

  if (!suggestedCommands.dev && !suggestedCommands.start) {
    const nested = await nestedNodeProjects(guard, packageManager);
    manifests.push(...nested.manifests);
    for (const project of nested.projects) {
      runtimes.add("node");
      project.frameworks.forEach((framework) => frameworks.add(framework));
    }
    const runnable = nested.projects.filter((project) => project.commands.dev || project.commands.start);
    if (nested.complete && runnable.length === 1) {
      const project = runnable[0]!;
      packageManager = project.packageManager;
      scripts = { ...project.scripts, ...scripts };
      for (const kind of ["dev", "start", "test", "build"] as const) {
        if (project.commands[kind]) suggestedCommands[kind] ??= project.commands[kind];
      }
      manifests.push(...project.manifests);
    }
  }

  return {
    root, name: basename(root), manifests: [...new Set(manifests)].slice(0, 100),
    runtimes: [...runtimes], frameworks: [...frameworks], packageManager, scripts, suggestedCommands,
  };
}
