import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryMemoryFeature, type RepositoryMemorySession } from "./index.js";
import { MAX_CONTEXT_BYTES, MAX_STATE_BYTES } from "./schema.js";
import { RepositoryMemoryStore } from "./store.js";

const temporaryDirectories: string[] = [];
const objective = "Improve the service module";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

async function fixture(): Promise<{
  root: string; directory: string; feature: RepositoryMemoryFeature;
  store: RepositoryMemoryStore; evidence: { path: string; hash: string }[];
}> {
  const base = await mkdtemp(join(tmpdir(), "span-repository-memory-"));
  temporaryDirectories.push(base);
  const root = join(base, "project");
  const directory = join(base, "memory");
  await mkdir(root);
  await writeFile(join(root, "service.ts"), "export const service = true;\n");
  const canonical = await realpath(root);
  return {
    root: canonical, directory,
    feature: new RepositoryMemoryFeature({ directory, enabled: true }),
    store: new RepositoryMemoryStore(directory),
    evidence: [{ path: "service.ts", hash: hash("export const service = true;\n") }],
  };
}

async function start(
  feature: RepositoryMemoryFeature, root: string,
  options: { sessionId?: string; objective?: string; signal?: AbortSignal } = {},
): Promise<RepositoryMemorySession> {
  const session = await feature.start({
    root, sessionId: options.sessionId ?? "task-1", runId: randomUUID(),
    objective: options.objective ?? objective,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  expect(session).toBeDefined();
  return session!;
}

function handoff(expectedRevision = 0, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "save_handoff", expectedRevision, objective,
    constraints: [], completed: ["Inspected the service implementation."],
    decisions: [], blockers: [], nextSteps: ["Update the service tests."], validation: [], evidence: [],
    ...overrides,
  };
}

function note(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "save_project_note", expectedRevision: 0, id,
    kind: "decision", text: "Keep the service module small.", reason: "Focused ownership.",
    scopePaths: ["service.ts"], evidence: [], ...overrides,
  };
}

function context(session: RepositoryMemorySession): {
  currentObjective: string; handoffRevision: number;
  handoff: null | Record<string, unknown>; unfinishedRun: null | Record<string, unknown>;
  projectNotes: Array<Record<string, unknown>>; withheldCodeClaims: number; omittedNotes: number;
} {
  return JSON.parse(session.context.slice(session.context.indexOf("\n") + 1));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RepositoryMemoryFeature", () => {
  it("does no project or memory IO when disabled, even for nonexistent roots", async () => {
    const base = await mkdtemp(join(tmpdir(), "span-memory-disabled-"));
    temporaryDirectories.push(base);
    const feature = new RepositoryMemoryFeature({ directory: join(base, "never-created") });
    expect(feature.enabled).toBe(false);
    await expect(feature.start({ root: join(base, "missing-project"), sessionId: "task", runId: "run", objective }))
      .resolves.toBeUndefined();
    expect(await readdir(base)).toEqual([]);
  });

  it("persists a task handoff through restart and isolates projects and sessions", async () => {
    const { root, directory, feature, store, evidence } = await fixture();
    const first = await start(feature, root);
    expect(first.revision).toBe(0);
    expect(first.needsHandoff).toBe(true);
    await first.execute(handoff(0, { constraints: ["Keep the public API stable."], evidence }));
    expect(first.revision).toBe(1);
    expect(first.needsHandoff).toBe(false);
    await first.finish();
    const reloaded = new RepositoryMemoryFeature({ directory, enabled: true });
    const resumed = await start(reloaded, root, { objective: "Continue" });
    expect(resumed.revision).toBe(1);
    expect(resumed.needsHandoff).toBe(true);
    expect(context(resumed)).toMatchObject({
      currentObjective: "Continue", handoffRevision: 1, unfinishedRun: null,
      handoff: { objective, constraints: ["Keep the public API stable."], evidenceStatus: "current" },
    });
    const otherTask = await start(reloaded, root, { sessionId: "different-task" });
    expect(context(otherTask).handoff).toBeNull();
    const otherRoot = join(dirname(root), "other-project");
    await mkdir(otherRoot);
    const otherProject = await start(reloaded, otherRoot);
    expect(context(otherProject).handoff).toBeNull();
    expect((await store.load(root)).handoffs).toHaveLength(1);
  });

  it("requires a fresh handoff at start and after progress or saving a project note", async () => {
    const { root, feature } = await fixture();
    const session = await start(feature, root);
    await expect(session.finish()).rejects.toMatchObject({ code: "MEMORY_HANDOFF_REQUIRED" });
    await session.execute(handoff());
    session.markProgress();
    await expect(session.finish()).rejects.toMatchObject({ code: "MEMORY_HANDOFF_REQUIRED" });
    await session.execute(handoff(1));
    await session.execute(note("service-design"));
    expect(session.needsHandoff).toBe(true);
    await session.execute(handoff(2));
    await session.finish();
    expect(session.metrics.status).toBe("finished");
    await expect(session.execute(handoff(3))).rejects.toMatchObject({ code: "MEMORY_SESSION_INACTIVE" });
  });

  it("preserves checkpoint constraints unless a user-requested revision reason is recorded", async () => {
    const { root, feature, store } = await fixture();
    const session = await start(feature, root);
    await session.execute(handoff(0, { constraints: ["Target Cursor."] }));
    await expect(session.execute(handoff(1))).rejects.toMatchObject({ code: "MEMORY_CONSTRAINT_DROPPED" });
    await expect(session.execute(handoff(1, { constraintsRevisionReason: " " }))).rejects.toThrow();
    await session.execute(handoff(1, {
      constraints: ["Target Span."],
      constraintsRevisionReason: "The user corrected the destination to Span.",
    }));
    await expect(session.execute(handoff(2))).rejects.toMatchObject({ code: "MEMORY_CONSTRAINT_DROPPED" });
    expect((await store.load(root)).handoffs[0]).toMatchObject({
      constraints: ["Target Span."], constraintsRevisionReason: "The user corrected the destination to Span.", revision: 2,
    });
    await expect(session.execute(handoff(2, { objective: "Unrelated work", constraints: ["Target Span."] })))
      .rejects.toMatchObject({ code: "MEMORY_OBJECTIVE_CHANGED" });
  });

  it("validates live hashes before saving and preserves the previous record after rejection", async () => {
    const { root, feature, store, evidence } = await fixture();
    const session = await start(feature, root);
    await session.execute(handoff(0, { evidence }));
    await writeFile(join(root, "service.ts"), "export const service = false;\n");
    await expect(session.execute(handoff(1, { evidence }))).rejects.toMatchObject({ code: "MEMORY_STALE_EVIDENCE" });
    await expect(session.execute(note("invalid-claim", { kind: "code-claim" })))
      .rejects.toMatchObject({ code: "MEMORY_EVIDENCE_REQUIRED" });
    const state = await store.load(root);
    expect(state.handoffs[0]?.revision).toBe(1);
    expect(state.notes).toEqual([]);
  });

  it("withholds changed code claims while labeling retained decisions and handoffs as historical", async () => {
    const { root, feature, evidence } = await fixture();
    const session = await start(feature, root);
    await session.execute(note("service-claim", { kind: "code-claim", evidence }));
    await session.execute(note("service-decision", { evidence }));
    await session.execute(handoff(0, { evidence }));
    await session.finish();
    await writeFile(join(root, "service.ts"), "export const service = false;\n");
    const resumed = await start(feature, root);
    const data = context(resumed);
    expect(data.withheldCodeClaims).toBe(1);
    expect(data.handoff).toMatchObject({ objective, evidenceStatus: "stale" });
    expect(data.projectNotes).toHaveLength(1);
    expect(data.projectNotes[0]).toMatchObject({
      id: "service-decision", evidenceStatus: "stale", meaning: "Historical decision; verify whether it still applies.",
    });
  });

  it("filters unrelated scoped notes before reading evidence and uses retained objective on continuation", async () => {
    const { root, feature, evidence } = await fixture();
    const session = await start(feature, root);
    await session.execute(note("service-claim", { kind: "code-claim", evidence }));
    await session.execute(note("billing-design", {
      text: "Billing batches invoices.", reason: "Accounting convention.", scopePaths: ["billing.ts"],
    }));
    await session.execute(note("global-design", {
      text: "Prefer local persistence.", reason: "Offline usage.", scopePaths: [],
    }));
    await session.execute(handoff());
    await session.finish();
    const resumed = await start(feature, root, { objective: "Continue" });
    expect(context(resumed).projectNotes.map((entry) => entry.id)).toEqual(expect.arrayContaining(["service-claim", "global-design"]));
    expect(context(resumed).projectNotes.map((entry) => entry.id)).not.toContain("billing-design");
    expect(context(resumed).omittedNotes).toBe(1);
  });

  it("rejects traversal, absolute paths, and evidence symlinks that escape the project", async () => {
    const { root, feature } = await fixture();
    const session = await start(feature, root);
    for (const path of ["../outside.txt", "C:\\outside.txt", "/outside.txt", "..\\outside.txt"]) {
      await expect(session.execute(handoff(0, { evidence: [{ path, hash: hash("outside") }] }))).rejects.toThrow();
    }
    const outside = join(dirname(root), "outside");
    await mkdir(outside);
    await writeFile(join(outside, "private.ts"), "outside");
    await symlink(outside, join(root, "linked"), "junction");
    await expect(session.execute(handoff(0, { evidence: [{ path: "linked/private.ts", hash: hash("outside") }] })))
      .rejects.toMatchObject({ code: "MEMORY_STALE_EVIDENCE" });
    await expect(session.execute(note("outside-scope", { scopePaths: ["linked/private.ts"] })))
      .rejects.toMatchObject({ code: "WORKSPACE_ESCAPE" });
  });

  it("rejects oversized source evidence without saving it", async () => {
    const { root, feature } = await fixture();
    const source = "x".repeat(2_000_001);
    await writeFile(join(root, "large.ts"), source);
    const session = await start(feature, root);
    await expect(session.execute(handoff(0, { evidence: [{ path: "large.ts", hash: hash(source) }] })))
      .rejects.toMatchObject({ code: "MEMORY_STALE_EVIDENCE" });
    expect(session.revision).toBe(0);
  });

  it("checks both note revisions during supersession and keeps the superseded record", async () => {
    const { root, feature, store } = await fixture();
    const session = await start(feature, root);
    await session.execute(note("old-design"));
    await expect(session.execute(note("new-design", { supersedesId: "old-design", supersedesRevision: 0 })))
      .rejects.toMatchObject({ code: "MEMORY_REVISION_CONFLICT" });
    expect((await store.load(root)).notes).toHaveLength(1);
    await session.execute(note("new-design", { supersedesId: "old-design", supersedesRevision: 1 }));
    const state = await store.load(root);
    expect(state.notes).toHaveLength(2);
    expect(state.notes.find((entry) => entry.id === "old-design")).toMatchObject({
      revision: 2, status: "superseded", supersededBy: "new-design",
    });
    await expect(session.execute(note("old-design", { expectedRevision: 2 })))
      .rejects.toMatchObject({ code: "MEMORY_NOTE_SUPERSEDED" });
    const resumed = await start(feature, root, { sessionId: "new-task" });
    expect(context(resumed).projectNotes.map((entry) => entry.id)).toEqual(["new-design"]);
  });

  it("serializes project writes across feature instances and rejects stale handoff updates", async () => {
    const { root, feature, directory, store } = await fixture();
    const secondFeature = new RepositoryMemoryFeature({ directory, enabled: true });
    const [first, second] = await Promise.all([start(feature, root), start(secondFeature, root)]);
    await Promise.all([first.execute(note("first-note")), second.execute(note("second-note"))]);
    expect((await store.load(root)).notes).toHaveLength(2);
    const outcomes = await Promise.allSettled([first.execute(handoff()), second.execute(handoff())]);
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((entry) => entry.status === "rejected")).toMatchObject({
      reason: { code: "MEMORY_REVISION_CONFLICT" },
    });
    expect((await store.load(root)).handoffs[0]?.revision).toBe(1);
  });

  it("retains data without reads or writes while off and invalidates sessions across a toggle", async () => {
    const { root, feature, store } = await fixture();
    const session = await start(feature, root);
    await session.execute(handoff());
    const before = await readFile(store.pathFor(root), "utf8");
    feature.setEnabled(false);
    expect(session.needsHandoff).toBe(false);
    await session.finish();
    await session.interrupt("disabled");
    session.markProgress();
    session.recordUsage({ prompt_tokens: 100 });
    await expect(session.execute(handoff(1))).rejects.toMatchObject({ code: "MEMORY_SESSION_INACTIVE" });
    expect(await readFile(store.pathFor(root), "utf8")).toBe(before);
    feature.setEnabled(true);
    await expect(session.execute(handoff(1))).rejects.toMatchObject({ code: "MEMORY_SESSION_INACTIVE" });
    const resumed = await start(feature, root);
    expect(resumed.revision).toBe(1);
    expect(context(resumed).unfinishedRun).toMatchObject({ status: "running" });
  });

  it("records interrupted status and actual usage after cancellation without fabricating a handoff", async () => {
    const { root, feature, store } = await fixture();
    const controller = new AbortController();
    const session = await start(feature, root, { signal: controller.signal });
    session.recordUsage({ prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 });
    session.recordUsage({ input_tokens: 50, output_tokens: 10, total_tokens: 60 });
    session.recordUsage({ prompt_tokens: -100, completion_tokens: Number.NaN });
    controller.abort();
    await session.interrupt("User stopped this run.");
    const state = await store.load(root);
    expect(state.handoffs).toEqual([]);
    expect(state.runs[0]).toMatchObject({
      status: "interrupted", reason: "User stopped this run.",
      providerInputTokens: 150, providerOutputTokens: 35, providerTotalTokens: 185,
      handoffSaves: 0,
    });
    expect(state.runs[0]?.estimatedContextTokens).toBe(Math.ceil(session.metrics.contextBytes / 4));
    const resumed = await start(feature, root);
    expect(context(resumed).unfinishedRun).toMatchObject({ status: "interrupted", reason: "User stopped this run." });
  });

  it("aborts before creating persisted state when a run is already cancelled", async () => {
    const { root, directory, feature } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(feature.start({ root, sessionId: "task", runId: "run", objective, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces UTF-8 handoff and context budgets without dropping the saved objective or constraints", async () => {
    const { root, feature } = await fixture();
    const session = await start(feature, root);
    await expect(session.execute(handoff(0, { completed: Array.from({ length: 10 }, () => "界".repeat(300)) })))
      .rejects.toMatchObject({ code: "MEMORY_HANDOFF_LIMIT" });
    await session.execute(handoff(0, { constraints: ["Retain this essential constraint."], completed: ["界".repeat(900)] }));
    for (let index = 0; index < 10; index += 1) {
      await session.execute(note("global-" + index, { text: "界".repeat(600), scopePaths: [], reason: "Durable project decision." }));
    }
    const resumed = await start(feature, root, { objective: "界".repeat(1500) });
    expect(Buffer.byteLength(resumed.context)).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
    expect(context(resumed).currentObjective).toContain("Full request remains");
    expect(context(resumed).handoff).toMatchObject({ objective, constraints: ["Retain this essential constraint."] });
    expect(context(resumed).omittedNotes).toBeGreaterThan(0);
    expect(context(resumed).projectNotes.length).toBeLessThan(10);
  });

  it("retains corrupt, oversized, and foreign-project state instead of silently rebuilding it", async () => {
    const { root, feature, store } = await fixture();
    const session = await start(feature, root);
    const path = store.pathFor(root);
    const valid = await store.load(root);
    for (const invalid of ["{broken", JSON.stringify({ ...valid, root: "another-project" }), "x".repeat(MAX_STATE_BYTES + 1)]) {
      await writeFile(path, invalid);
      await expect(session.execute(handoff())).rejects.toMatchObject({ code: "MEMORY_STATE_INVALID" });
      expect(await readFile(path, "utf8")).toBe(invalid);
      expect((await readdir(dirname(path))).filter((entry) => entry.endsWith(".tmp") || entry.endsWith(".lock"))).toEqual([]);
    }
    await writeFile(path, JSON.stringify(valid));
    await expect(session.execute(handoff())).resolves.toMatchObject({ saved: true, revision: 1 });
  });

  it("does not remove another writer's lock and can recover once that writer releases it", async () => {
    const { root, feature, store } = await fixture();
    const session = await start(feature, root);
    const lock = store.pathFor(root) + ".lock";
    await writeFile(lock, "owned by another process");
    await expect(session.execute(handoff())).rejects.toMatchObject({ code: "MEMORY_BUSY" });
    expect(await readFile(lock, "utf8")).toBe("owned by another process");
    await rm(lock);
    await expect(session.execute(handoff())).resolves.toMatchObject({ saved: true });
  });

  it("rejects handoff and run state with duplicate identities", async () => {
    const { root, feature, store } = await fixture();
    const session = await start(feature, root);
    await session.execute(handoff());
    const state = await store.load(root);
    state.handoffs.push(state.handoffs[0]!);
    await writeFile(store.pathFor(root), JSON.stringify(state));
    await expect(start(feature, root)).rejects.toMatchObject({ code: "MEMORY_STATE_INVALID" });
  });
  it("persists only the host checkpoint and exposes the previous saved checkpoint on resume", async () => {
    const { root, feature, store } = await fixture();
    const firstCheckpoint = { messageCount: 3, digest: hash("first three messages") };
    const first = await feature.start({
      root, sessionId: "task-1", runId: randomUUID(), objective, historyCheckpoint: firstCheckpoint,
    });
    expect(first?.historyCheckpoint).toBeUndefined();
    await expect(first!.execute(handoff(0, { historyCheckpoint: { messageCount: 500, digest: hash("AI override") } })))
      .rejects.toThrow();
    await first!.execute(handoff());
    await first!.finish();
    expect((await store.load(root)).handoffs[0]?.historyCheckpoint).toEqual(firstCheckpoint);
    const nextCheckpoint = { messageCount: 5, digest: hash("all five messages including memory-off work") };
    const resumed = await feature.start({
      root, sessionId: "task-1", runId: randomUUID(), objective, historyCheckpoint: nextCheckpoint,
    });
    expect(resumed?.historyCheckpoint).toEqual(firstCheckpoint);
    await resumed!.execute(handoff(1));
    expect((await store.load(root)).handoffs[0]?.historyCheckpoint).toEqual(nextCheckpoint);
    const noCheckpoint = await start(feature, root, { sessionId: "task-without-checkpoint" });
    expect(noCheckpoint.historyCheckpoint).toBeUndefined();
    await noCheckpoint.execute(handoff());
    expect((await store.load(root)).handoffs.find((entry) => entry.sessionId === "task-without-checkpoint")?.historyCheckpoint)
      .toBeUndefined();
  });

  it("validates host checkpoint bounds before touching persisted state", async () => {
    const { root, directory, feature } = await fixture();
    for (const historyCheckpoint of [
      { messageCount: 501, digest: hash("too many") },
      { messageCount: -1, digest: hash("negative") },
      { messageCount: 1, digest: "not a digest" },
    ]) {
      await expect(feature.start({ root, sessionId: "task", runId: randomUUID(), objective, historyCheckpoint })).rejects.toThrow();
    }
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks progress when finishing after waiting for another project writer", async () => {
    const { root, feature, store } = await fixture();
    const session = await start(feature, root);
    await session.execute(handoff());
    let release!: () => void;
    let writerEntered!: () => void;
    const entered = new Promise<void>((resolve) => { writerEntered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const writer = store.update(root, () => undefined, async () => {
      writerEntered();
      await blocked;
    });
    await entered;
    const finishing = session.finish();
    session.markProgress();
    release();
    await writer;
    await expect(finishing).rejects.toMatchObject({ code: "MEMORY_HANDOFF_REQUIRED" });
    expect((await store.load(root)).runs[0]?.status).toBe("running");
    await session.execute(handoff(1));
    await session.finish();
  });

  it.each(["界".repeat(1500), String.fromCharCode(1).repeat(1500)])(
    "accepts the host-displayed bounded objective in a first-run handoff",
    async (longObjective) => {
      const { root, feature, store } = await fixture();
      const session = await start(feature, root, { objective: longObjective });
      const displayedObjective = context(session).currentObjective;
      expect(displayedObjective).not.toBe(longObjective);
      expect(Buffer.byteLength(JSON.stringify(displayedObjective))).toBeLessThanOrEqual(2000);
      expect(Buffer.byteLength(session.context)).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
      await expect(session.execute(handoff(0, { objective: displayedObjective })))
        .resolves.toMatchObject({ saved: true, revision: 1 });
      await session.finish();
      expect((await store.load(root)).handoffs[0]?.objective).toBe(displayedObjective);
      expect(session.metrics.status).toBe("finished");
    },
  );

});
