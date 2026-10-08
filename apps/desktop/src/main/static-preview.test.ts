import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { describe, expect, it } from "vitest";
import { WorkspaceGuard } from "../../../daemon/src/workspace-guard";
import { StaticPreview } from "./static-preview";

describe("automatic static preview", () => {
  it("serves HTML and assets, reuses its port, and rejects private files and writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "static-preview-"));
    const preview = new StaticPreview();
    try {
      await writeFile(join(root, "index.html"), "<h1>Local app</h1>");
      await writeFile(join(root, "app.js"), "console.log('ready')");
      await writeFile(join(root, ".env"), "PRIVATE=1");
      await writeFile(join(root, "app.db"), "private database");
      await mkdir(join(root, ".git")); await writeFile(join(root, ".git", "config.txt"), "private");
      const workspace = await WorkspaceGuard.create(root);
      const url = await preview.start(workspace, null);
      expect(await (await fetch(url)).text()).toContain("Local app");
      expect((await fetch(`${url}app.js`)).headers.get("content-type")).toContain("javascript");
      for (const path of [".env", "app.db", ".git/config.txt", "%2e%2e%2fsecret.html"]) expect((await fetch(url + path)).status).toBe(404);
      expect((await fetch(url, { method: "POST", body: "change" })).status).toBe(405);
      const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
        get(url, { headers: { host: "attacker.example" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
      });
      expect(rejectedHost).toBe(403);
      await preview.stop();
      expect(preview.running).toBe(false);
      expect(await preview.start(workspace, url)).toBe(url);
    } finally { await preview.stop(); await rm(root, { recursive: true, force: true }); }
  });

  it("opens a single HTML file even when it is not named index.html", async () => {
    const root = await mkdtemp(join(tmpdir(), "static-page-"));
    const preview = new StaticPreview();
    try {
      await writeFile(join(root, "dashboard.html"), "<h1>Dashboard</h1>");
      const url = await preview.start(await WorkspaceGuard.create(root), null);
      expect(await (await fetch(url)).text()).toContain("Dashboard");
    } finally { await preview.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
