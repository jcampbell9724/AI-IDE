import { readFile } from "node:fs/promises";
import type { WorkspaceGuard } from "./workspace-guard.js";

export interface DetectedBackend {
  command: string;
  runtime: "node" | "bun" | "python";
  framework?: string;
}

export async function detectBackend(guard: WorkspaceGuard): Promise<DetectedBackend | undefined> {
  const paths = ["server", "app", "index", "src/server", "src/app", "src/index"]
    .flatMap((name) => ["js", "mjs", "cjs", "ts"].map((extension) => `${name}.${extension}`));
  for (const path of paths) {
    try {
      const source = (await readFile(await guard.resolvePath(path, { mustExist: true }), "utf8")).slice(0, 200_000);
      if (/\bBun\.serve\s*\(/.test(source)) return { command: `bun ${path}`, runtime: "bun" };
      // Creating/exporting a server alone does not mean this file starts listening.
      if (!path.endsWith(".ts") && /\.listen\s*\(/.test(source) && !/\bDeno\./.test(source)) {
        return { command: `node ${path}`, runtime: "node" };
      }
    } catch { /* Try the next conventional entry point. */ }
  }
  for (const name of ["app", "main", "server"]) {
    try {
      const source = (await readFile(await guard.resolvePath(`${name}.py`, { mustExist: true }), "utf8")).slice(0, 200_000);
      const fastApi = /^([A-Za-z_]\w*)\s*=\s*(?:fastapi\.)?FastAPI\s*\(/m.exec(source);
      if (fastApi) return {
        command: `python -m uvicorn ${name}:${fastApi[1]} --host 127.0.0.1 --port 8000`,
        runtime: "python", framework: "fastapi",
      };
      const flask = /^([A-Za-z_]\w*)\s*=\s*(?:flask\.)?Flask\s*\(/m.exec(source);
      if (flask) return {
        command: `python -m flask --app ${name}:${flask[1]} run --host 127.0.0.1 --port 5000`,
        runtime: "python", framework: "flask",
      };
      if (/\.serve_forever\s*\(/.test(source)) return { command: `python ${name}.py`, runtime: "python" };
    } catch { /* No recognized Python entry point. */ }
  }
  return undefined;
}

export async function detectBackendCommand(guard: WorkspaceGuard): Promise<string | undefined> {
  return (await detectBackend(guard))?.command;
}
