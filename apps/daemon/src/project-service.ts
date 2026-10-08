import type {
  ProjectRecord,
  ProjectSelectionRequest,
  ProjectState,
} from "@browser-agent/shared";
import { AppError } from "./errors.js";
import { commandInvocation, parseCommandLine } from "./command.js";
import { detectProject } from "./project-detection.js";
import { ProjectStore } from "./project-store.js";
import { WorkspaceGuard } from "./workspace-guard.js";

function detectedDevelopmentCommand(
  detection: ProjectRecord["detection"],
): string | null {
  return detection.suggestedCommands.dev ?? detection.suggestedCommands.start ?? null;
}

export class ProjectService {
  private guard: WorkspaceGuard | undefined;
  private activeRuns = 0;
  private changingSelection = false;

  constructor(private readonly store: ProjectStore) {}

  assertCanSelect(): void {
    if (this.activeRuns > 0) {
      throw new AppError("PROJECT_IN_USE", "Wait for the active agent run to finish before switching projects.", 409);
    }
    this.assertNotChanging();
  }

  assertNotChanging(): void {
    if (this.changingSelection) {
      throw new AppError("PROJECT_CHANGING", "Wait for project selection to finish.", 409);
    }
  }

  lockSelection(): () => void {
    if (this.changingSelection) {
      throw new AppError("PROJECT_CHANGING", "Wait for project selection to finish before starting a run.", 409);
    }
    this.activeRuns += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRuns -= 1;
    };
  }

  private async changeSelection<T>(change: () => Promise<T>, metadataOnly = false): Promise<T> {
    if (metadataOnly) {
      if (this.changingSelection) {
        throw new AppError("PROJECT_CHANGING", "Wait for project selection to finish.", 409);
      }
    } else {
      this.assertCanSelect();
    }
    this.changingSelection = true;
    try {
      return await change();
    } finally {
      this.changingSelection = false;
    }
  }

  async getState(): Promise<ProjectState> {
    return this.store.snapshot();
  }

  async select(input: ProjectSelectionRequest): Promise<ProjectState> {
    return this.changeSelection(async () => {
      const detection = await detectProject(input.path);
      const state = await this.store.snapshot();
      const saved = state.recent.find((project) => project.root === detection.root);
      // Omitting the command reopens a project; an empty/whitespace-only
      // command explicitly restores automatic detection. Never promote a
      // detected command to custom.
      const requestedCommand = input.devCommand === undefined
        ? undefined
        : input.devCommand.trim() || undefined;
      const savedCustom = saved?.devCommandSource !== "detected"
        ? saved?.devCommand?.trim() || undefined
        : undefined;
      const customCommand = requestedCommand ?? (input.devCommand === undefined ? savedCustom : undefined);
      if (customCommand) {
        const parsed = parseCommandLine(customCommand);
        commandInvocation(parsed.command, parsed.args);
      }
      const nextGuard = await WorkspaceGuard.create(detection.root);
      const devCommand = customCommand || detectedDevelopmentCommand(detection);
      const devCommandSource = customCommand ? "custom" : "detected";
      // A stale preview URL must not survive an explicit run-command change.
      // Only preserve the saved URL when the caller did not change the command
      // (omitted) and did not provide a new URL, or when the resolved command
      // is identical to the saved one.
      const commandChanged = input.devCommand !== undefined
        && (requestedCommand ?? null) !== (saved?.devCommand?.trim() || null);
      const url = input.url ?? (commandChanged ? null : saved?.url ?? null);
      const record: ProjectRecord = {
        root: detection.root,
        detection,
        devCommand,
        devCommandSource,
        url,
        selectedAt: new Date().toISOString(),
      };
      const next = await this.store.select(record);
      this.guard = nextGuard;
      return next;
    });
  }

  async clearCurrent(): Promise<ProjectState> {
    return this.changeSelection(async () => {
      const next = await this.store.clearCurrent();
      this.guard = undefined;
      return next;
    });
  }

  async setPreviewUrl(url: string, expectedRoot?: string): Promise<ProjectState> {
    return this.changeSelection(async () => {
      const current = await this.current();
      if (expectedRoot !== undefined && current.root !== expectedRoot) {
        throw new AppError("PROJECT_CHANGED", "The selected project changed before its preview was ready.", 409);
      }
      return this.store.select({ ...current, url });
    }, true);
  }

  async removeRecent(path: string): Promise<ProjectState> {
    return this.changeSelection(async () => {
      if (this.activeRuns > 0) {
        const current = (await this.store.snapshot()).current;
        if (current?.root === path) {
          throw new AppError("PROJECT_IN_USE", "Wait for the active agent run to finish before removing the current project.", 409);
        }
      }
      const next = await this.store.removeRecent(path);
      if (next.current === null) this.guard = undefined;
      return next;
    }, true);
  }

  async setPinned(path: string, pinned: boolean): Promise<ProjectState> {
    return this.changeSelection(async () => this.store.setPinned(path, pinned), true);
  }

  async ensureDevCommand(): Promise<string | null> {
    // Refreshing the run command for the *same* project must work while an
    // agent run is active (dev server and agent runs are independent). Only a
    // workspace switch under a running agent is unsafe.
    return this.changeSelection(async () => {
      const current = await this.current();
      // Older records have no provenance; preserve their saved commands as
      // overrides, but re-validate so a legacy invalid command cannot wedge
      // starts forever.
      const savedCustom = current.devCommand?.trim() || undefined;
      if (savedCustom && current.devCommandSource !== "detected") {
        try {
          const parsed = parseCommandLine(savedCustom);
          commandInvocation(parsed.command, parsed.args);
          return current.devCommand;
        } catch {
          // Fall through to re-detection below.
        }
      }
      const detection = await detectProject(current.root);
      if (this.activeRuns > 0 && detection.root !== current.root) {
        throw new AppError("PROJECT_IN_USE", "Wait for the active agent run to finish before switching projects.", 409);
      }
      const detected = detectedDevelopmentCommand(detection);

      const nextGuard = await WorkspaceGuard.create(detection.root);
      await this.store.select({
        ...current,
        root: detection.root,
        detection,
        devCommand: detected,
        devCommandSource: "detected",
      });
      this.guard = nextGuard;
      return detected;
    }, true);
  }

  async current(): Promise<ProjectRecord> {
    const current = (await this.store.snapshot()).current;
    if (current === null) {
      throw new AppError("PROJECT_NOT_SELECTED", "Select a project first", 409);
    }
    return current;
  }

  async workspace(): Promise<WorkspaceGuard> {
    const current = await this.current();
    if (this.guard?.root !== current.root) {
      this.guard = await WorkspaceGuard.create(current.root);
    }
    return this.guard;
  }
}
