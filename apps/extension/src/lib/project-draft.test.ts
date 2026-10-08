import { describe, expect, it } from "vitest";
import { projectDraftSync, projectSettingsForPath } from "./project-draft";
import type { ProjectInfo } from "./types";

function project(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return { status: "stopped", ...overrides };
}

describe("project draft synchronization", () => {
  it("clears settings copied from a previously selected project when the path changes", () => {
    const selected = project({
      path: "C:\\projects\\first",
      devCommand: "pnpm run dev",
      url: "http://localhost:5173",
    });

    expect(projectSettingsForPath(selected, "C:\\projects\\second")).toEqual({
      devCommand: "",
      projectUrl: "",
    });
    expect(projectSettingsForPath(selected, selected.path!)).toEqual({
      devCommand: "pnpm run dev",
      projectUrl: "http://localhost:5173",
    });
  });

  it("does not overwrite a local draft for an unchanged server snapshot", () => {
    const current = project({ path: "C:\\projects\\demo", devCommand: "pnpm run dev" });

    expect(projectDraftSync(current, { ...current })).toEqual({
      path: false,
      command: false,
      url: false,
    });
  });

  it("syncs a newly detected command returned for the selected path", () => {
    const previous = project({ path: "C:\\projects\\demo" });
    const next = project({ path: "C:\\projects\\demo", devCommand: "npm run start:dev" });

    expect(projectDraftSync(previous, next).command).toBe(true);
  });
});
