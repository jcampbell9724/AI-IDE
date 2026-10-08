import type { ProjectRecord } from "@browser-agent/shared";
import { describe, expect, it, vi } from "vitest";
import { ProjectActions, type ProjectActionDependencies } from "./project-actions";

type Workspace = Awaited<ReturnType<ProjectActionDependencies["projects"]["workspace"]>>;
type ProcessStatus = ReturnType<ProjectActionDependencies["processes"]["status"]>;

function fixture(command: string | null = "npm run dev") {
  const events: string[] = [];
  let processState: ProcessStatus["state"] = "stopped";
  let staticRunning = false;
  let record: ProjectRecord = {
    root: "C:\\project",
    detection: {
      root: "C:\\project", name: "project", manifests: [], runtimes: [], frameworks: [],
      packageManager: null, scripts: {}, suggestedCommands: {},
    },
    devCommand: command, devCommandSource: "detected", url: null, selectedAt: "2026-09-15T00:00:00Z",
  };
  const workspace = { root: record.root } as Workspace;
  const projects = {
    assertNotChanging: vi.fn(),
    current: vi.fn(async () => record),
    ensureDevCommand: vi.fn(async () => command),
    workspace: vi.fn(async () => workspace),
    setPreviewUrl: vi.fn(async (url: string, _expectedRoot?: string) => {
      record = { ...record, url };
      return { current: record, recent: [record], pinned: [] };
    }),
  };
  const status = (): ProcessStatus => ({ state: processState, pid: null, startedAt: null, exitCode: null, command });
  const processes = {
    status: vi.fn(status),
    logsAfter: vi.fn((_after: number) => ({ logs: [] as Array<{ seq: number; timestamp: string; stream: "stdout"; text: string }>, next: 7 })),
    start: vi.fn(async (_workspace: Workspace, _command: string) => {
      events.push("process:start"); processState = "running"; return status();
    }),
    stop: vi.fn(async () => {
      events.push("process:stop"); processState = "stopped"; return status();
    }),
  };
  const staticPreview = {
    get running() { return staticRunning; },
    start: vi.fn(async (_workspace: Workspace, _preferredUrl: string | null) => {
      events.push("static:start"); staticRunning = true; return "http://127.0.0.1:4321/";
    }),
    stop: vi.fn(async () => { events.push("static:stop"); staticRunning = false; }),
  };
  const previewStartup = {
    cancel: vi.fn(() => { events.push("preview:cancel"); }),
    start: vi.fn<ProjectActionDependencies["previewStartup"]["start"]>(async (_url, launch) => { await launch(); }),
  };
  const navigate = vi.fn(async (_url: string, _signal: AbortSignal) => {});
  const emitSnapshot = vi.fn(async () => { events.push("snapshot"); });
  const deps = { projects, processes, staticPreview, previewStartup, navigate, emitSnapshot } satisfies ProjectActionDependencies;
  return {
    deps, events, projects, processes, staticPreview, previewStartup, navigate, emitSnapshot,
    setRecord: (updates: Partial<ProjectRecord>) => { record = { ...record, ...updates }; },
    setProcessState: (state: ProcessStatus["state"]) => { processState = state; },
    setStaticRunning: (running: boolean) => { staticRunning = running; },
  };
}

describe("project actions", () => {
  it("restarts a static preview as a command with only the new server running", async () => {
    const test = fixture();
    test.setStaticRunning(true);
    await new ProjectActions().run("restart", test.deps);
    expect(test.events).toEqual(["preview:cancel", "static:stop", "process:stop", "process:start", "snapshot"]);
    expect(test.staticPreview.running).toBe(false);
    expect(test.processes.status().state).toBe("running");
  });

  it("restarts a command as static HTML after re-detection removes the command", async () => {
    const test = fixture(null);
    test.setProcessState("running");
    await new ProjectActions().run("restart", test.deps);
    expect(test.events).toEqual(["preview:cancel", "static:stop", "process:stop", "static:start", "snapshot"]);
    expect(test.processes.status().state).toBe("stopped");
    expect(test.staticPreview.running).toBe(true);
    expect(test.projects.setPreviewUrl).toHaveBeenCalledWith("http://127.0.0.1:4321/", "C:\\project");
    expect(test.processes.start).not.toHaveBeenCalled();
  });

  it("uses the refreshed project record and reserves the action while detection is pending", async () => {
    const test = fixture();
    const actions = new ProjectActions();
    let completeDetection!: (command: string | null) => void;
    test.projects.ensureDevCommand.mockImplementation(() => new Promise((resolve) => { completeDetection = resolve; }));
    const pending = actions.run("start", test.deps);
    expect(() => actions.assertIdle()).toThrow("current project action");
    await expect(actions.run("restart", test.deps)).rejects.toThrow("current project action");
    expect(test.processes.start).not.toHaveBeenCalled();
    test.setRecord({ url: "http://localhost:8080/" });
    completeDetection("npm run serve");
    await pending;
    expect(test.previewStartup.start.mock.calls[0]?.[0]).toBe("http://localhost:8080/");
    expect(test.processes.start).toHaveBeenCalledWith(expect.objectContaining({ root: "C:\\project" }), "npm run serve");
    expect(() => actions.assertIdle()).not.toThrow();
  });

  it("publishes failure state and releases the action after a launch error", async () => {
    const test = fixture();
    const actions = new ProjectActions();
    test.processes.start.mockImplementation(async () => {
      test.setProcessState("failed");
      throw new Error("Executable missing");
    });
    await expect(actions.run("start", test.deps)).rejects.toThrow("Executable missing");
    expect(test.emitSnapshot).toHaveBeenCalledOnce();
    expect(test.processes.status().state).toBe("failed");
    expect(() => actions.assertIdle()).not.toThrow();
    await actions.run("stop", test.deps);
    expect(test.processes.status().state).toBe("stopped");
  });

  it("publishes detection errors without stopping a working server", async () => {
    const test = fixture();
    test.setProcessState("running");
    test.projects.ensureDevCommand.mockRejectedValue(new Error("Invalid package.json"));
    await expect(new ProjectActions().run("restart", test.deps)).rejects.toThrow("Invalid package.json");
    expect(test.processes.stop).not.toHaveBeenCalled();
    expect(test.emitSnapshot).toHaveBeenCalledOnce();
  });

  it("allows Stop during an agent run and attempts both stops when one fails", async () => {
    const test = fixture();
    test.projects.assertNotChanging.mockImplementation(() => { throw new Error("Selection changing"); });
    test.staticPreview.stop.mockRejectedValue(new Error("Static stop failed"));
    await expect(new ProjectActions().run("stop", test.deps)).rejects.toThrow("Static stop failed");
    expect(test.projects.assertNotChanging).not.toHaveBeenCalled();
    expect(test.processes.stop).toHaveBeenCalledOnce();
    expect(test.previewStartup.cancel).toHaveBeenCalledOnce();
    expect(test.emitSnapshot).toHaveBeenCalledOnce();
  });

  it("rejects Start while a static preview already runs", async () => {
    const test = fixture();
    test.setStaticRunning(true);
    await expect(new ProjectActions().run("start", test.deps)).rejects.toThrow("already running");
    expect(test.processes.start).not.toHaveBeenCalled();
    expect(test.previewStartup.cancel).not.toHaveBeenCalled();
  });

  it("keeps discovering new addresses with a saved URL and persists the recovered address", async () => {
    const test = fixture();
    test.setRecord({ url: "http://localhost:3000/" });
    await new ProjectActions().run("start", test.deps);
    const startup = test.previewStartup.start.mock.calls[0]!;
    test.processes.logsAfter.mockReturnValue({
      logs: [{ seq: 8, timestamp: "2026-09-15T00:00:00Z", stream: "stdout", text: "Ready http://localhost:3001/" }], next: 8,
    });
    expect(startup[4]?.()).toBe("http://localhost:3001/");
    expect(test.processes.logsAfter).toHaveBeenLastCalledWith(7);
    const signal = new AbortController().signal;
    await startup[3]("http://localhost:3001/", signal);
    expect(test.projects.setPreviewUrl).toHaveBeenCalledWith("http://localhost:3001/", "C:\\project");
    expect(test.navigate).toHaveBeenCalledWith("http://localhost:3001/", signal);
  });

  it.each(["cancelled", "switched"])("ignores a %s startup before it can update another preview", async (reason) => {
    const test = fixture();
    await new ProjectActions().run("start", test.deps);
    const navigate = test.previewStartup.start.mock.calls[0]![3];
    const controller = new AbortController();
    if (reason === "cancelled") controller.abort();
    else test.setRecord({ root: "C:\\another-project" });
    await navigate("http://localhost:3001/", controller.signal);
    expect(test.projects.setPreviewUrl).not.toHaveBeenCalled();
    expect(test.navigate).not.toHaveBeenCalled();
  });

  it("does not navigate after cancellation while the recovered URL is being saved", async () => {
    const test = fixture();
    await new ProjectActions().run("start", test.deps);
    const controller = new AbortController();
    const save = test.projects.setPreviewUrl.getMockImplementation()!;
    test.projects.setPreviewUrl.mockImplementation(async (...args) => {
      const state = await save(...args);
      controller.abort();
      return state;
    });
    await test.previewStartup.start.mock.calls[0]![3]("http://localhost:3001/", controller.signal);
    expect(test.navigate).not.toHaveBeenCalled();
  });

  it("shuts down a new static server if saving its address fails", async () => {
    const test = fixture(null);
    test.projects.setPreviewUrl.mockRejectedValue(new Error("Project changed"));
    await expect(new ProjectActions().run("start", test.deps)).rejects.toThrow("Project changed");
    expect(test.staticPreview.running).toBe(false);
    expect(test.staticPreview.stop).toHaveBeenCalledOnce();
    expect(test.previewStartup.start).not.toHaveBeenCalled();
    expect(test.emitSnapshot).toHaveBeenCalledOnce();
  });

  it("releases the action when publishing the snapshot fails", async () => {
    const test = fixture();
    const actions = new ProjectActions();
    test.emitSnapshot.mockRejectedValue(new Error("Window closed"));
    await expect(actions.run("stop", test.deps)).rejects.toThrow("Window closed");
    expect(() => actions.assertIdle()).not.toThrow();
  });
});
