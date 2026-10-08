import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "./project-detection.js";
import { parseCommandLine, commandInvocation } from "./command.js";

const temporaryDirectories: string[] = [];

async function projectFixture(files: Record<string, string | object>) {
  const root = await mkdtemp(join(tmpdir(), "detect-project-"));
  temporaryDirectories.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("detectProject", () => {
  it.each(["manage.py", "app.py", "Cargo.toml"])("prefers a package start script over fallback detection from %s", async (file) => {
    const root = await mkdtemp(join(tmpdir(), "detect-start-priority-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));
    await writeFile(join(root, file), "");
    const detection = await detectProject(root);
    expect(detection.suggestedCommands.dev).toBeUndefined();
    expect(detection.suggestedCommands.start).toBe("npm run start");
  });

  it.each(["dev:start", "dev:server"])("recognizes the development script %s", async (script) => {
    const root = await mkdtemp(join(tmpdir(), "detect-dev-script-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { [script]: "node server.js" } }));
    expect((await detectProject(root)).suggestedCommands.dev).toBe(`npm run ${script}`);
  });

  it("detects a Vite/React pnpm project and its commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "detect-node-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: { dev: "vite", test: "vitest", build: "vite build" },
        dependencies: { react: "latest" },
        devDependencies: { vite: "latest" },
      }),
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const detection = await detectProject(root);

    expect(detection.runtimes).toContain("node");
    expect(detection.frameworks).toEqual(expect.arrayContaining(["react", "vite"]));
    expect(detection.packageManager).toBe("pnpm");
    expect(detection.suggestedCommands).toMatchObject({
      dev: "pnpm run dev",
      test: "pnpm run test",
      build: "pnpm run build",
    });
  });

  it("honors packageManager and chooses the first non-empty high-confidence dev script", async () => {
    const root = await mkdtemp(join(tmpdir(), "detect-package-manager-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        packageManager: "yarn@4.9.2+sha512.example",
        scripts: {
          dev: "   ",
          "start:dev": "vite --host",
          develop: "vite",
          start: "node server.js",
        },
      }),
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(root, "yarn.lock"), "# yarn lockfile\n");

    const detection = await detectProject(root);

    expect(detection.packageManager).toBe("yarn");
    expect(detection.manifests).toEqual(
      expect.arrayContaining(["package.json", "pnpm-lock.yaml", "yarn.lock"]),
    );
    expect(detection.scripts).not.toHaveProperty("dev");
    expect(detection.suggestedCommands).toMatchObject({
      dev: "yarn run start:dev",
      start: "yarn run start",
    });
  });

  it("reports malformed package.json files as actionable manifest errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "detect-malformed-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), "{ invalid json\n");

    await expect(detectProject(root)).rejects.toMatchObject({
      code: "INVALID_PROJECT_MANIFEST",
      message: "package.json is not valid JSON. Fix it before starting this project.",
    });
  });

  it("detects Python/Django and Rust manifests without executing project code", async () => {
    const root = await mkdtemp(join(tmpdir(), "detect-mixed-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "manage.py"), "raise RuntimeError('must not execute')\n");
    await writeFile(join(root, "pyproject.toml"), "[project]\nname='example'\n");
    await writeFile(join(root, "Cargo.toml"), "[package]\nname='example'\nversion='0.1.0'\n");

    const detection = await detectProject(root);

    expect(detection.runtimes).toEqual(expect.arrayContaining(["python", "rust"]));
    expect(detection.frameworks).toContain("django");
    expect(detection.suggestedCommands.dev).toBe("python manage.py runserver");
    expect(detection.suggestedCommands.test).toBe("cargo test");
  });

  it.each([
    ["npm", "--prefix"], ["pnpm", "--dir"], ["yarn", "--cwd"], ["bun", "--cwd"],
  ])("starts a unique nested app using %s from the selected workspace", async (manager, flag) => {
    const root = await projectFixture({
      "package.json": { packageManager: `${manager}@1.0.0`, scripts: { build: "build-all" } },
      "apps/my web/package.json": { scripts: { dev: "vite", test: "vitest" }, devDependencies: { vite: "1" } },
      "packages/utils/package.json": { scripts: { build: "tsc" } },
    });
    const detection = await detectProject(root);
    expect(detection.root).toBe(root);
    expect(detection.packageManager).toBe(manager);
    expect(detection.suggestedCommands.dev).toBe(`${manager} ${flag} "./apps/my web" run dev`);
    expect(detection.suggestedCommands.build).toBe(`${manager} run build`);
    expect(detection.manifests).toContain("apps/my web/package.json");
    expect(detection.frameworks).toContain("vite");
    const parsed = parseCommandLine(detection.suggestedCommands.dev!);
    expect(parsed.args).toEqual([flag, "./apps/my web", "run", "dev"]);
    expect(() => commandInvocation(parsed.command, parsed.args)).not.toThrow();
  });

  it("inherits a workspace manager even without a root package.json and honors a child override", async () => {
    const root = await projectFixture({
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "apps/web/package.json": { scripts: { dev: "vite" } },
    });
    expect((await detectProject(root)).suggestedCommands.dev).toBe('pnpm --dir "./apps/web" run dev');
    await writeFile(join(root, "apps/web/package.json"), JSON.stringify({
      packageManager: "bun@1.2.0", scripts: { dev: "vite" },
    }));
    expect((await detectProject(root)).suggestedCommands.dev).toBe('bun --cwd "./apps/web" run dev');
  });

  it("keeps multiple nested apps discoverable without arbitrarily selecting one", async () => {
    const root = await projectFixture({
      "apps/web/package.json": { scripts: { dev: "vite" }, dependencies: { react: "1" } },
      "apps/admin/package.json": { scripts: { start: "next start" }, dependencies: { next: "1" } },
    });
    const detection = await detectProject(root);
    expect(detection.suggestedCommands).toEqual({});
    expect(detection.manifests).toEqual(expect.arrayContaining(["apps/web/package.json", "apps/admin/package.json"]));
    expect(detection.frameworks).toEqual(expect.arrayContaining(["react", "next"]));
  });

  it("keeps root start scripts ahead of nested app commands", async () => {
    const root = await projectFixture({
      "package.json": { scripts: { start: "start-all" } },
      "apps/web/package.json": { scripts: { dev: "vite" } },
    });
    expect((await detectProject(root)).suggestedCommands).toEqual({ start: "npm run start" });
  });

  it("ignores dependencies, generated output, fixtures, and external directory links", async () => {
    const root = await projectFixture({
      "node_modules/dep/package.json": { scripts: { dev: "wrong" } },
      "dist/package.json": { scripts: { dev: "wrong" } },
      "tests/fixture/package.json": { scripts: { dev: "wrong" } },
      "apps/web/package.json": { scripts: { dev: "vite" } },
    });
    const outside = await projectFixture({ "package.json": { scripts: { dev: "outside" } } });
    await symlink(outside, join(root, "linked-app"), process.platform === "win32" ? "junction" : "dir");
    const detection = await detectProject(root);
    expect(detection.manifests).toEqual(["apps/web/package.json"]);
    expect(detection.suggestedCommands.dev).toBe('npm --prefix "./apps/web" run dev');
  });

  it("does not choose a sibling when a nested manifest is invalid", async () => {
    const root = await projectFixture({
      "apps/web/package.json": { scripts: { dev: "vite" } },
      "apps/broken/package.json": "{broken",
    });
    const detection = await detectProject(root);
    expect(detection.suggestedCommands.dev).toBeUndefined();
    expect(detection.manifests).toContain("apps/broken/package.json");
  });

  it("accepts a UTF-8 BOM and recognizes modern framework package names", async () => {
    const root = await projectFixture({
      "package.json": '\uFEFF' + JSON.stringify({
        scripts: ["vite"], dependencies: { "@remix-run/react": "1", "@sveltejs/kit": "1", nuxt: "1" },
      }),
      "npm-shrinkwrap.json": "{}",
    });
    const detection = await detectProject(root);
    expect(detection.scripts).toEqual({});
    expect(detection.frameworks).toEqual(expect.arrayContaining(["remix", "sveltekit", "nuxt"]));
    expect(detection.packageManager).toBe("npm");
  });

  it("does not infer runnable applications from a Python helper or Rust library", async () => {
    const root = await projectFixture({
      "app.py": "def helper():\n  return 42\n",
      "Cargo.toml": '[package]\nname = "library"\n[lib]\npath = "src/lib.rs"\n',
      "src/lib.rs": "pub fn helper() {}",
    });
    const detection = await detectProject(root);
    expect(detection.runtimes).toEqual(expect.arrayContaining(["python", "rust"]));
    expect(detection.frameworks).not.toContain("flask-or-python-web");
    expect(detection.suggestedCommands.dev).toBeUndefined();
    await writeFile(join(root, "src/main.rs"), "fn main() {}");
    expect((await detectProject(root)).suggestedCommands.dev).toBe("cargo run");
  });

  it("exposes root HTML files for static preview without mislabeling an HTML directory", async () => {
    const root = await projectFixture({ "index.html": "<h1>Hello</h1>", "contact.HTM": "<h1>Contact</h1>" });
    await mkdir(join(root, "folder.html"));
    const detection = await detectProject(root);
    expect(detection.manifests).toEqual(["contact.HTM", "index.html"]);
    expect(detection.suggestedCommands).toEqual({});
  });
});
