import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DevProcessManager } from "./process-manager.js";
import { WorkspaceGuard } from "./workspace-guard.js";

describe("development process recovery", () => {
  it("allows log clearing after a missing executable, with or without Stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "process-recovery-"));
    const manager = new DevProcessManager();
    try {
      const guard = await WorkspaceGuard.create(root);
      const missing = `"${join(root, "missing-executable")}"`;
      await expect(manager.start(guard, missing)).rejects.toMatchObject({ code: "ENOENT" });
      expect(manager.status()).toMatchObject({ state: "failed", pid: null });
      expect(() => manager.clearLogs()).not.toThrow();
      await expect(manager.start(guard, missing)).rejects.toMatchObject({ code: "ENOENT" });
      await manager.stop();
      expect(manager.status()).toMatchObject({ state: "stopped", pid: null });
      expect(() => manager.clearLogs()).not.toThrow();
      expect(manager.logsAfter(0).logs).toEqual([]);
    } finally {
      await manager.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
