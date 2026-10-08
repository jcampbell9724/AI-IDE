import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DesktopProject } from "../../shared/contracts";
import { ProjectSidebar } from "./project-sidebar";

const appSource = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
const source = await readFile(new URL("./project-sidebar.tsx", import.meta.url), "utf8");

function buttonWithLabel(label: string): string {
  return [...source.matchAll(/<button\b(?:(?!<\/button>).)*<\/button>/gs)]
    .map((match) => match[0])
    .find((button) => button.includes(label)) ?? "";
}

function buttonForAction(action: "start" | "stop" | "restart"): string {
  return buttonWithLabel(`props.onProjectAction("${action}")`);
}

describe("desktop project run controls", () => {
  it("routes Start through the existing desktop project action", () => {
    const controller = appSource.slice(
      appSource.indexOf("async function controlProject"),
      appSource.indexOf("async function runBrowserAction"),
    );
    const runButton = buttonForAction("start");

    expect(controller).toMatch(/window\.browserAgent\.projectAction\(action\)/);
    expect(controller).toMatch(/setSnapshot\(\(current\)\s*=>\s*current\s*\?\s*\{\s*\.\.\.current,\s*project\s*}/);
    expect(appSource).toContain("onProjectAction={(action) => void controlProject(action)}");
    expect(runButton).toContain('props.onProjectAction("start")');
  });

  it("keeps Start, Stop, and Restart together in the project sidepane", () => {
    expect(source).toContain('const projectActive = ["starting", "running", "restarting", "stopping"].includes(projectStatus)');
    const actions = source.slice(source.indexOf('<div className="project-sidebar-run-actions">'), source.indexOf('</div>', source.indexOf('<div className="project-sidebar-run-actions">')));
    expect(actions.indexOf('props.onProjectAction("start")')).toBeLessThan(actions.indexOf('props.onProjectAction("stop")'));
    expect(actions.indexOf('props.onProjectAction("stop")')).toBeLessThan(actions.indexOf('props.onProjectAction("restart")'));
    expect(buttonForAction("stop")).toContain('props.onProjectAction("stop")');
    expect(buttonForAction("restart")).toContain('props.onProjectAction("restart")');
  });

  it("shows the current project status in the sidepane", () => {
    expect(source).toContain("formatProjectStatus(projectStatus)");
    expect(source).toContain('className="project-run-heading"');
  });

  it("keeps the detected run command editable and offers explicit re-detection", () => {
    const saveButton = buttonWithLabel(">Save<");
    const detectButton = buttonWithLabel("Auto-detect");

    expect(source).toContain('id="sidebar-project-run-command"');
    expect(source).toContain("value={projectRunCommand}");
    expect(source).toContain("setProjectRunCommand(event.target.value)");
    expect(appSource).toContain("onSaveProjectRunCommand={(command) => void updateProjectRunCommand(command)}");
    expect(appSource).toContain("onAutodetectProjectRunCommand={() => updateProjectRunCommand()}");
    expect(source).toContain("props.onSaveProjectRunCommand(projectRunCommand.trim())");
    expect(source).toContain("const command = await props.onAutodetectProjectRunCommand()");
    expect(source).toContain('setProjectRunCommand(command ?? "")');
    expect(saveButton).toContain('type="submit"');
    expect(detectButton).toContain("autodetectProjectRunCommand()");
  });

  it("keeps Start, Stop and Restart available during agent work (only switching is blocked)", () => {
    const html = renderProject({ status: "running" }, { runActive: true });
    expect(renderedButton(html, "Start")).toContain("disabled");
    expect(renderedButton(html, "Restart")).not.toContain("disabled");
    expect(renderedButton(html, "Stop")).not.toContain("disabled");
    const stopped = renderProject({ status: "stopped" }, { runActive: true });
    expect(renderedButton(stopped, "Start")).not.toContain("disabled");
    expect(renderedButton(stopped, "Stop")).toContain("disabled");
  });

  it("blocks every preview launch entry point while a run command has unsaved changes", () => {
    const controller = appSource.slice(appSource.indexOf("async function controlProject"), appSource.indexOf("async function pickBrowserElement"));
    expect(controller).toMatch(/action !== "stop" && projectRunCommandDirtyRef\.current/);
    expect(controller.indexOf("projectRunCommandDirtyRef.current")).toBeLessThan(controller.indexOf("window.browserAgent.projectAction(action)"));
    const previewStartButtons = [...appSource.matchAll(/<button\b(?:(?!<\/button>).)*<\/button>/gs)]
      .map((match) => match[0]).filter((button) => button.includes('controlProject("start")'));
    expect(previewStartButtons).toHaveLength(2);
    for (const button of previewStartButtons) expect(button).toMatch(/disabled=\{[^}]*projectRunCommandDirty/);
    const recovery = appSource.slice(appSource.indexOf("<PreviewStatus"), appSource.indexOf("onEditCommand={() => void editRunCommand()}"));
    expect(recovery).toContain("busy={setupBusy || running || projectRunCommandDirty}");
    expect(buttonForAction("stop")).not.toContain("projectRunCommandChanged");
  });

  it("clears shared command draft state when the sidebar or selected project changes", () => {
    expect(appSource).toMatch(/const onRunCommandDirtyChange = useCallback\(\(dirty: boolean\): void => \{\s*projectRunCommandDirtyRef\.current = dirty;\s*setProjectRunCommandDirty\(dirty\);\s*}, \[\]\)/);
    expect(appSource).toContain("onRunCommandDirtyChange={onRunCommandDirtyChange}");
    expect(source).toContain("onRunCommandDirtyChange(event.target.value.trim() !== savedProjectRunCommand)");
    expect(source).toContain("onRunCommandDirtyChange(projectRunCommandChanged)");
    expect(source).toContain("useEffect(() => () => onRunCommandDirtyChange(false), [onRunCommandDirtyChange])");
    expect(appSource).toMatch(/<ProjectSidebar\s+key=\{snapshot\?\.project\.path \?\? ""}/);
    expect(appSource).toMatch(/if \(loadedProjectPathRef\.current === projectPath\) return;\s*onRunCommandDirtyChange\(false\)/);
  });

  it("shows the detected command before history and surfaces failures with recovery", () => {
    const html = renderProject({ status: "failed", error: "Missing dependencies. Run npm install." });
    expect(html).toContain("Detected run command");
    expect(html).toContain("npm run dev</code>");
    expect(html.indexOf("npm run dev</code>")).toBeLessThan(html.indexOf("Project history"));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Missing dependencies. Run npm install.");
    expect(renderedButton(html, "Retry start")).not.toContain("disabled");
    expect(renderedButton(html, "View logs")).not.toBe("");
  });

  it("distinguishes static pages, ambiguous app folders, and custom commands", () => {
    expect(renderProject({ devCommandSource: "custom" })).toContain("Custom run command");
    const detection = baseProject.detection!;
    expect(renderProject({ devCommand: null, detection: { ...detection, manifests: ["index.html"] } })).toContain("HTML preview");
    const ambiguous = renderProject({ devCommand: null, detection: { ...detection, manifests: ["apps/web/package.json", "apps/admin/package.json"] } });
    expect(ambiguous).toContain("This folder contains several apps.");
    expect(ambiguous).toContain("apps/web</li>");
    expect(ambiguous).not.toContain("HTML preview");
  });
});

const baseProject: DesktopProject = {
  path: "/workspace/app", name: "App", url: null, devCommand: "npm run dev", devCommandSource: "detected", status: "stopped", pid: null,
  detection: { root: "/workspace/app", name: "App", manifests: ["package.json"], runtimes: ["node"], frameworks: ["vite"], packageManager: "npm", scripts: { dev: "vite" }, suggestedCommands: { dev: "npm run dev" } },
};

function renderProject(project: Partial<DesktopProject>, options: { runActive?: boolean } = {}): string {
  const noop = (): void => {};
  return renderToStaticMarkup(createElement(ProjectSidebar, {
    project: { ...baseProject, ...project }, recentProjects: [], busy: false, ...options,
    onChooseProject: noop, onCreateProject: noop, onSelectRecentProject: noop, onRemoveRecentProject: noop,
    onToggleProjectPinned: noop, onSaveProjectRunCommand: noop, onAutodetectProjectRunCommand: async () => null,
    onRunCommandDirtyChange: noop,
    onProjectAction: noop, onViewLogs: noop,
  }));
}

function renderedButton(html: string, label: string): string {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((button) => button.endsWith(`>${label}</button>`)) ?? "";
}
