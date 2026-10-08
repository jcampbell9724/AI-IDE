import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { DaemonRuntime } from "@browser-agent/daemon";

type Workspace = Awaited<ReturnType<DaemonRuntime["projects"]["workspace"]>>;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4", ".mp3": "audio/mpeg",
};

function allowed(path: string): boolean {
  return !path.split(/[\\/]/).some((part) => part.startsWith(".") || part === "node_modules")
    && Boolean(TYPES[extname(path).toLowerCase()]);
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export class StaticPreview {
  private server: Server | undefined;
  url: string | null = null;
  get running(): boolean { return Boolean(this.server?.listening); }

  async start(workspace: Workspace, preferredUrl: string | null): Promise<string> {
    if (this.running) throw new Error("The project preview is already running.");
    let port = 0;
    try { port = preferredUrl ? Number(new URL(preferredUrl).port) : 0; } catch { /* Choose a free port. */ }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) port = 0;
    const server = createServer((request, response) => {
      const address = server.address();
      const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
      if (request.headers.host !== host && request.headers.host !== host.replace("127.0.0.1", "localhost")) {
        response.writeHead(403).end("Local preview only."); return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
      void this.serve(workspace, request.url ?? "/", request.method === "HEAD", response).catch(() => {
        if (!response.headersSent) response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("File not available in this preview.");
      });
    });
    const listen = (chosen: number): Promise<void> => new Promise((resolve, reject) => {
      const failed = (error: Error): void => { server.off("listening", ready); reject(error); };
      const ready = (): void => { server.off("error", failed); resolve(); };
      server.once("error", failed); server.once("listening", ready); server.listen(chosen, "127.0.0.1");
    });
    try { await listen(port); }
    catch (error) { if (port && (error as NodeJS.ErrnoException).code === "EADDRINUSE") await listen(0); else throw error; }
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No preview port was assigned.");
    this.url = `http://127.0.0.1:${address.port}/`;
    return this.url;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined; this.url = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async serve(workspace: Workspace, raw: string, head: boolean, response: ServerResponse): Promise<void> {
    const path = decodeURIComponent(raw.split("?")[0] ?? "/").replace(/^\//, "");
    if (path.includes("\\") || path.includes(":")) throw new Error("Invalid path");
    let candidate = path || "index.html";
    if (!path) {
      const pages = (await readdir(workspace.root)).filter((name) => /\.html?$/i.test(name) && allowed(name));
      if (!pages.includes("index.html")) {
        if (pages.length === 1) candidate = pages[0]!;
        else {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          response.end(head ? undefined : `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project preview</title><style>body{margin:0;padding:clamp(24px,6vw,72px);font:16px/1.6 "Segoe UI",Arial,sans-serif;color:#18253b;background:#faf9f6}main{max-width:640px;margin:8vh auto}h1{font-size:28px;line-height:1.2}a{color:#1949bd}a:focus-visible{outline:2px solid #245eea;outline-offset:4px}p{overflow-wrap:anywhere}</style><main><h1>${pages.length ? "Choose a page" : "No HTML page found"}</h1>${pages.map((name) => `<p><a href="/${encodeURIComponent(name)}">${escapeHtml(name)}</a></p>`).join("")}<p>Open the folder containing your website, or set its run command in Projects → Run settings and choose Start. This built-in preview serves HTML and web assets; backend APIs need their own server.</p></main></html>`);
          return;
        }
      }
    }
    if (candidate.endsWith("/")) candidate += "index.html";
    if (!allowed(candidate)) throw new Error("Not a web asset");
    const file = await workspace.resolvePath(candidate, { mustExist: true });
    if (!allowed(workspace.relative(file))) throw new Error("Not a web asset");
    const info = await stat(file);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("File too large");
    response.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()]!, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(head ? undefined : await readFile(file));
  }
}
