import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ProjectStateSchema,
  type ProjectRecord,
  type ProjectState,
} from "@browser-agent/shared";

const EMPTY_STATE: ProjectState = { current: null, recent: [], pinned: [] };

function emptyState(): ProjectState {
  return { current: null, recent: [], pinned: [] };
}

export class ProjectStore {
  private state: ProjectState = emptyState();
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly stateFile: string) {}

  async load(): Promise<ProjectState> {
    if (this.initialized) return structuredClone(this.state);
    try {
      const parsed: unknown = JSON.parse(await readFile(this.stateFile, "utf8"));
      this.state = ProjectStateSchema.parse(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = emptyState();
      } else if (error instanceof SyntaxError || (error as { name?: string }).name === "ZodError") {
        // Recover from a corrupt state file instead of bricking the projects
        // feature. The next successful persist overwrites the bad file.
        this.state = emptyState();
      } else if ((error as NodeJS.ErrnoException).code !== undefined) {
        // I/O errors other than missing file are still fatal, but never
        // return a partially parsed state.
        throw error;
      } else {
        this.state = emptyState();
      }
    }
    this.initialized = true;
    return structuredClone(this.state);
  }

  async select(project: ProjectRecord): Promise<ProjectState> {
    const current = await this.loadInternal();
    const recent = [
      project,
      ...current.recent.filter((candidate) => candidate.root !== project.root),
    ];
    this.state = { current: project, recent, pinned: current.pinned };
    await this.persist();
    return structuredClone(this.state);
  }

  async clearCurrent(): Promise<ProjectState> {
    const current = await this.loadInternal();
    if (current.current === null) return structuredClone(current);
    this.state = { ...current, current: null };
    await this.persist();
    return structuredClone(this.state);
  }

  async removeRecent(path: string): Promise<ProjectState> {
    const current = await this.loadInternal();
    const recent = current.recent.filter((project) => project.root !== path);
    const pinned = current.pinned.filter((candidate) => candidate !== path);
    // Removing the active project must also clear it; otherwise the UI keeps
    // showing a project that no longer exists in history.
    const nextCurrent = current.current?.root === path ? null : current.current;
    this.state = {
      ...current,
      current: nextCurrent,
      recent,
      pinned,
    };
    await this.persist();
    return structuredClone(this.state);
  }

  async setPinned(path: string, pinned: boolean): Promise<ProjectState> {
    const current = await this.loadInternal();
    if (!current.recent.some((project) => project.root === path)) return structuredClone(current);
    const nextPinned = pinned
      ? [path, ...current.pinned.filter((candidate) => candidate !== path)]
      : current.pinned.filter((candidate) => candidate !== path);
    this.state = { ...current, pinned: nextPinned };
    await this.persist();
    return structuredClone(this.state);
  }

  async snapshot(): Promise<ProjectState> {
    const state = await this.load();
    return structuredClone(state);
  }

  private async loadInternal(): Promise<ProjectState> {
    await this.load();
    return this.state;
  }

  private async persist(): Promise<void> {
    // Serialize writes in-process so concurrent select/remove/pin cannot
    // interleave a read-modify-write cycle and lose updates. Each persist
    // uses a unique temp file to avoid same-pid clashes.
    const snapshot = structuredClone(this.state);
    const previous = this.writeChain;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.writeChain = previous.then(() => current);
    await previous;
    try {
      await mkdir(dirname(this.stateFile), { recursive: true });
      const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.stateFile);
    } finally {
      release();
    }
  }
}
