import { describe, expect, it } from "vitest";
import { discoverLocalUrl, inferLocalUrl } from "./project-url-discovery";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceGuard } from "../../../daemon/src/workspace-guard";

describe("project output URL discovery", () => {
  it("uses explicit command or source ports for backends that do not log a URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "backend-port-"));
    try {
      const workspace = await WorkspaceGuard.create(root);
      await writeFile(join(root, "server.js"), "const port = 3210;\nserver.listen(port);");
      expect(await inferLocalUrl(workspace, "node server.js")).toBe("http://127.0.0.1:3210/");
      expect(await inferLocalUrl(workspace, "python -m uvicorn main:app --port 8000")).toBe("http://127.0.0.1:8000/");
      await writeFile(join(root, "server.js"), "server.listen(4321);");
      expect(await inferLocalUrl(workspace, "node server.js")).toBe("http://127.0.0.1:4321/");
      await writeFile(join(root, "server.js"), "server.listen(process.env.PORT);");
      expect(await inferLocalUrl(workspace, "node server.js")).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("chooses the latest local URL and converts the all-interfaces bind address", () => {
    expect(discoverLocalUrl([{ text: "Starting http://localhost:5000" }, { text: "Ready at http://0.0.0.0:8000/" }])).toBe("http://127.0.0.1:8000/");
  });
  it("ignores external URLs and invalid ports", () => {
    expect(discoverLocalUrl([{ text: "https://example.com:3000 http://localhost:99999" }])).toBeNull();
    expect(discoverLocalUrl([{ text: "http://[::1]:8080/" }])).toBe("http://[::1]:8080/");
  });
});
