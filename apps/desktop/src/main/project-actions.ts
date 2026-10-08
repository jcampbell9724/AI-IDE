import type { DaemonRuntime } from "@browser-agent/daemon";
import type { PreviewStartup } from "./preview-startup";
import type { StaticPreview } from "./static-preview";
import { discoverLocalUrl, inferLocalUrl } from "./project-url-discovery";

export type ProjectAction = "start" | "stop" | "restart";

export interface ProjectActionDependencies {
  readonly projects: Pick<DaemonRuntime["projects"], "assertNotChanging" | "current" | "ensureDevCommand" | "workspace" | "setPreviewUrl">;
  readonly processes: Pick<DaemonRuntime["processes"], "status" | "logsAfter" | "start" | "stop">;
  readonly staticPreview: Pick<StaticPreview, "running" | "start" | "stop">;
  readonly previewStartup: Pick<PreviewStartup, "cancel" | "start">;
  readonly navigate: (url: string, signal: AbortSignal) => Promise<unknown>;
  readonly emitSnapshot: () => Promise<unknown>;
}

async function stopServers(deps: ProjectActionDependencies): Promise<void> {
  // Attempt both stops even if one server cannot be shut down.
  const results = await Promise.allSettled([deps.staticPreview.stop(), deps.processes.stop()]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

export class ProjectActions {
  private actionInFlight = false;

  assertIdle(): void {
    if (this.actionInFlight) throw new Error("Wait for the current project action to finish.");
  }

  async run(action: ProjectAction, deps: ProjectActionDependencies): Promise<void> {
    this.assertIdle();
    this.actionInFlight = true;
    try {
      if (action === "stop") {
        deps.previewStartup.cancel();
        await stopServers(deps);
        return;
      }

      // Starting or restarting the dev server for the *current* project is
      // independent of agent runs (separate process manager). Only block when
      // a project switch is already in progress.
      deps.projects.assertNotChanging();
      if (action === "start" && (deps.staticPreview.running || !["stopped", "failed"].includes(deps.processes.status().state))) {
        const state = deps.staticPreview.running ? "running" : deps.processes.status().state;
        if (state === "starting") throw new Error("The project is already starting. Wait for it to finish.");
        if (state === "restarting") throw new Error("The project is already restarting. Wait for it to finish.");
        if (state === "stopping") throw new Error("The project is stopping. Wait for it to stop, then start it again.");
        throw new Error("The project is already running. Stop or restart it first.");
      }
      const command = await deps.projects.ensureDevCommand();
      const project = await deps.projects.current();
      const workspace = await deps.projects.workspace();
      deps.previewStartup.cancel();
      if (action === "restart") await stopServers(deps);

      if (!command) {
        const url = await deps.staticPreview.start(workspace, project.url);
        try {
          await deps.projects.setPreviewUrl(url, project.root);
          await deps.previewStartup.start(url, async () => {}, () => deps.staticPreview.running, deps.navigate);
        } catch (error) {
          await deps.staticPreview.stop();
          throw error;
        }
        return;
      }

      const logCursor = deps.processes.logsAfter(0).next;
      const inferredUrl = await inferLocalUrl(workspace, command);
      await deps.previewStartup.start(project.url,
        () => deps.processes.start(workspace, command),
        () => deps.processes.status().state === "running",
        async (url, signal) => {
          if (signal.aborted) return;
          const current = await deps.projects.current();
          if (signal.aborted || current.root !== project.root) return;
          if (current.url !== url) await deps.projects.setPreviewUrl(url, project.root);
          if (signal.aborted) return;
          return deps.navigate(url, signal);
        },
        () => discoverLocalUrl(deps.processes.logsAfter(logCursor).logs) ?? inferredUrl,
      );
    } finally {
      try { await deps.emitSnapshot(); }
      finally { this.actionInFlight = false; }
    }
  }
}
