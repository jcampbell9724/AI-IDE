import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "./project-detection.js";

describe("automatic backend detection", () => {
  it.each([
    ["server.js", "require('http').createServer(handler).listen(3000)", "node server.js"],
    ["main.py", "from fastapi import FastAPI\napi = FastAPI()", "python -m uvicorn main:api --host 127.0.0.1 --port 8000"],
    ["app.py", "from flask import Flask\napp = Flask(__name__)", "python -m flask --app app:app run --host 127.0.0.1 --port 5000"],
  ])("detects %s alongside static HTML and a database", async (file, source, command) => {
    const root = await mkdtemp(join(tmpdir(), "detect-backend-"));
    try {
      await writeFile(join(root, file), source);
      await writeFile(join(root, "index.html"), "<h1>App</h1>");
      await writeFile(join(root, "app.db"), "database");
      expect((await detectProject(root)).suggestedCommands.dev).toBe(command);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("does not invent an API for a database file and preserves an explicit package script", async () => {
    const root = await mkdtemp(join(tmpdir(), "detect-static-"));
    try {
      await writeFile(join(root, "index.html"), "<h1>App</h1>");
      await writeFile(join(root, "app.db"), "database");
      expect((await detectProject(root)).suggestedCommands.dev).toBeUndefined();
      await writeFile(join(root, "server.js"), "server.listen(3000)");
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { dev: "custom-server" } }));
      expect((await detectProject(root)).suggestedCommands.dev).toBe("npm run dev");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
