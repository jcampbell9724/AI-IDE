import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DesktopSettingsStore, type SecretCodec } from "./settings-store";

function codec(): SecretCodec {
  return {
    available: true,
    backend: "test",
    encrypt: async (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decrypt: async (value) => ({
      value: value.toString("utf8").replace(/^encrypted:/, ""),
      shouldReEncrypt: false,
    }),
  };
}

describe("DesktopSettingsStore", () => {
  it("stores the API key encrypted and never returns it with normal settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-agent-settings-"));
    const path = join(directory, "settings.json");
    const store = new DesktopSettingsStore(path, codec());

    const settings = await store.update({ apiKey: "sk-secret", selectedModel: "model/id" });

    expect(settings).not.toHaveProperty("apiKey");
    expect(await store.getApiKey()).toBe("sk-secret");
    expect(await readFile(path, "utf8")).not.toContain("sk-secret");
  });

  it("refuses to save plaintext when secure storage is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-agent-settings-"));
    const store = new DesktopSettingsStore(join(directory, "settings.json"), {
      ...codec(),
      available: false,
    });

    await expect(store.update({ apiKey: "sk-secret" })).rejects.toThrow("unavailable");
  });

  it("migrates older settings with codebase mapping off and persists the opt-in", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-agent-settings-map-"));
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      selectedModel: "model/id",
      approvalMode: "ask",
      launchAtLogin: false,
    }));
    const store = new DesktopSettingsStore(path, codec());

    expect((await store.load()).codebaseMapEnabled).toBe(false);
    expect((await store.update({ codebaseMapEnabled: true })).codebaseMapEnabled).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ codebaseMapEnabled: true });
  });

  it("migrates existing settings with repository memory off without changing the map preference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "span-settings-memory-"));
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      selectedModel: "model/id",
      approvalMode: "auto-safe",
      launchAtLogin: true,
      codebaseMapEnabled: true,
    }));

    expect(await new DesktopSettingsStore(path, codec()).load()).toMatchObject({
      repositoryMemoryEnabled: false,
      codebaseMapEnabled: true,
      selectedModel: "model/id",
      approvalMode: "auto-safe",
      launchAtLogin: true,
    });
  });

  it("persists memory opt-in and opt-out across restarts and unrelated preference updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "span-settings-memory-"));
    const path = join(directory, "settings.json");
    const firstStore = new DesktopSettingsStore(path, codec());
    expect((await firstStore.load()).repositoryMemoryEnabled).toBe(false);
    await firstStore.update({ codebaseMapEnabled: true, repositoryMemoryEnabled: true });

    const restartedStore = new DesktopSettingsStore(path, codec());
    expect((await restartedStore.load()).repositoryMemoryEnabled).toBe(true);
    await restartedStore.update({ selectedModel: "another/model" });
    expect((await restartedStore.load()).repositoryMemoryEnabled).toBe(true);
    await restartedStore.update({ repositoryMemoryEnabled: false });

    expect(await new DesktopSettingsStore(path, codec()).load()).toMatchObject({
      repositoryMemoryEnabled: false,
      codebaseMapEnabled: true,
      selectedModel: "another/model",
    });
  });

  it("rejects an invalid memory preference before replacing persisted settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "span-settings-memory-"));
    const path = join(directory, "settings.json");
    const store = new DesktopSettingsStore(path, codec());
    await store.update({ repositoryMemoryEnabled: true });
    const before = await readFile(path, "utf8");

    await expect(store.update({ repositoryMemoryEnabled: "yes" as unknown as boolean })).rejects.toThrow();
    expect((await store.load()).repositoryMemoryEnabled).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
