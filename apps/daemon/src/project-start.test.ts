import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfig } from "./config.js";
import { DevProcessManager } from "./process-manager.js";
import { ProjectService } from "./project-service.js";
import { ProjectStore } from "./project-store.js";
import { createDaemonServer, type DaemonDependencies } from "./server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("project start route", () => {
  it("re-detects a missing command before starting the selected project", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-start-route-"));
    temporaryDirectories.push(root);
    const stateFile = join(root, ".browser-agent-state.json");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo" }));
    const projects = new ProjectService(new ProjectStore(stateFile));
    await projects.select({ path: root });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "npm@11.0.0", scripts: { "start:dev": "vite" } }),
    );

    const processes = new DevProcessManager();
    const start = vi.spyOn(processes, "start").mockResolvedValue(processes.status());
    const config: DaemonConfig = {
      host: "127.0.0.1",
      port: 0,
      bearerToken: "test-token",
      generatedBearerToken: false,
      stateFile,
      openRouterBaseUrl: "https://openrouter.test/api/v1",
      openRouterTitle: "test",
      allowedOrigins: [],
      codebaseMapEnabled: false,
    };
    const server = createDaemonServer({
      config,
      projects,
      processes,
    } as unknown as DaemonDependencies);

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, config.host, resolve);
      });
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://${config.host}:${address.port}/v1/project/start`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token" },
      });

      expect(response.status).toBe(200);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]?.[1]).toBe("npm run start:dev");
      expect(await response.json()).toMatchObject({ devCommand: "npm run start:dev" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
