import type { ProjectInfo } from "./types";

export interface ProjectDraftSync {
  readonly path: boolean;
  readonly command: boolean;
  readonly url: boolean;
}

export function projectDraftSync(
  previous: ProjectInfo,
  next: ProjectInfo,
  force = false,
): ProjectDraftSync {
  const pathChanged = previous.path !== next.path;
  return {
    path: force || pathChanged,
    command: force || pathChanged || previous.devCommand !== next.devCommand,
    url: force || pathChanged || previous.url !== next.url,
  };
}

export function projectSettingsForPath(
  selected: ProjectInfo,
  path: string,
): { devCommand: string; projectUrl: string } {
  if (!selected.path || path !== selected.path) {
    return { devCommand: "", projectUrl: "" };
  }
  return {
    devCommand: selected.devCommand ?? "",
    projectUrl: selected.url ?? "",
  };
}
