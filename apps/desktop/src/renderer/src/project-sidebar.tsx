import { UiIcon } from "./ui-icon";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { previewStatusLabel } from "./preview-status";
import type {
  DesktopProject,
  DesktopRecentProject,
} from "../../shared/contracts";

interface ProjectSidebarProps {
  readonly project: DesktopProject | undefined;
  readonly recentProjects: readonly DesktopRecentProject[];
  readonly busy: boolean;
  readonly runActive?: boolean;
  readonly actionError?: string;
  readonly onViewLogs?: () => void;
  readonly onChooseProject: () => void;
  readonly onCreateProject: (name: string) => void;
  readonly onSelectRecentProject: (project: DesktopRecentProject) => void;
  readonly onRemoveRecentProject: (project: DesktopRecentProject) => void;
  readonly onToggleProjectPinned: (project: DesktopRecentProject) => void;
  readonly onSaveProjectRunCommand: (command: string) => void;
  readonly onAutodetectProjectRunCommand: () => Promise<string | null | undefined>;
  readonly onRunCommandDirtyChange: (dirty: boolean) => void;
  readonly onProjectAction: (action: "start" | "stop" | "restart") => void;
}

export function ProjectSidebar(props: ProjectSidebarProps): ReactElement {
  const projectPath = props.project?.path ?? null;
  const projectStatus = props.project?.status ?? "stopped";
  const projectActive = ["starting", "running", "restarting", "stopping"].includes(projectStatus);
  const projectCanRestart = projectStatus === "running";
  const selectionDisabled = props.busy || Boolean(props.runActive);
  const [showProjectCreator, setShowProjectCreator] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [projectRunCommand, setProjectRunCommand] = useState(props.project?.devCommand ?? "");
  const savedProjectRunCommand = props.project?.devCommand ?? "";
  const projectRunCommandChanged = projectRunCommand.trim() !== savedProjectRunCommand;
  const onRunCommandDirtyChange = props.onRunCommandDirtyChange;
  const detection = props.project?.detection;
  const detectedTools = [...new Set([...(detection?.frameworks ?? []), ...(detection?.runtimes ?? []), ...(detection?.packageManager ? [detection.packageManager] : [])])];
  const nestedPackages = (detection?.manifests ?? []).filter((path) => path.endsWith("/package.json"));
  const hasHtml = (detection?.manifests ?? []).some((path) => /\.html?$/i.test(path));
  const startupError = props.actionError || (props.project?.previewStartup?.phase === "failed" ? props.project.previewStartup.message : "") || (projectStatus === "failed" ? props.project?.error : "");
  const historicalProjects = useMemo(
    () => props.recentProjects
      .filter((project) => project.path !== projectPath)
      .sort((left, right) => Number(right.pinned) - Number(left.pinned)),
    [projectPath, props.recentProjects],
  );

  const [autodetecting, setAutodetecting] = useState(false);
  // Only reset the input when switching projects. Syncing on every saved
  // change would clobber typing; autodetect/save update the input explicitly.
  useEffect(() => {
    setProjectRunCommand(savedProjectRunCommand);
  }, [projectPath]);

  useEffect(() => {
    onRunCommandDirtyChange(projectRunCommandChanged);
  }, [onRunCommandDirtyChange, projectRunCommandChanged]);

  useEffect(() => () => onRunCommandDirtyChange(false), [onRunCommandDirtyChange]);

  async function autodetectProjectRunCommand(): Promise<void> {
    if (autodetecting) return;
    setAutodetecting(true);
    try {
      const command = await props.onAutodetectProjectRunCommand();
      if (command !== undefined) setProjectRunCommand(command ?? "");
    } finally {
      setAutodetecting(false);
    }
  }

  return <section className="project-sidebar" aria-label="Projects">
    <header className="sidebar-panel-header">
      <div>
        <span>Projects</span>
        <strong title={props.project?.name ?? "No project selected"}>{props.project?.name ?? "No project selected"}</strong>
      </div>
      <span className={`project-status-dot ${projectStatus}`} aria-label={formatProjectStatus(projectStatus)} title={formatProjectStatus(projectStatus)} />
    </header>

    <div className="project-sidebar-controls project-management-controls">
      <div className="project-picker-actions">
        <button className="button ghost compact" type="button" onClick={props.onChooseProject} disabled={selectionDisabled}>{projectActive ? "Stop and open project" : "Open project"}</button>
        <button className="button primary compact" type="button" onClick={() => setShowProjectCreator((visible) => !visible)} disabled={selectionDisabled}>{showProjectCreator ? "Cancel" : "Create new project"}</button>
      </div>
      {props.runActive && <p role="status">Wait for the agent to finish before switching projects. You can still start or stop this project's server.</p>}
      {projectActive && !props.runActive && <p className="project-preview-status">Switching projects stops this project's server first.</p>}

      {showProjectCreator && <div className="project-sidebar-creator">
        <label htmlFor="sidebar-new-project-name">Project name</label>
        <input id="sidebar-new-project-name" type="text" value={newProjectName} maxLength={100} onChange={(event) => setNewProjectName(event.target.value)} placeholder="My new project" autoFocus />
        <button className="button primary compact" type="button" onClick={() => props.onCreateProject(newProjectName.trim())} disabled={selectionDisabled || !newProjectName.trim()}>{props.busy ? "Creating…" : projectActive ? "Stop project and create" : "Choose location and create"}</button>
      </div>}

      {projectPath && <section className="current-project-controls" aria-label="Current project controls">
        <div className="project-path" title={projectPath}>{projectPath}</div>
        <div className="project-detection-summary">
          {detectedTools.length > 0 && <ul className="project-detection-tags" aria-label="Detected project tools">{detectedTools.map((tool) => <li key={tool}>{tool}</li>)}</ul>}
          <strong>{savedProjectRunCommand ? props.project?.devCommandSource === "custom" ? "Custom run command" : "Detected run command" : hasHtml ? "HTML preview" : "No start command found"}</strong>
          {savedProjectRunCommand ? <code>{savedProjectRunCommand}</code> : <p>{nestedPackages.length > 1 ? "This folder contains several apps. Open an app's folder or set its run command below." : hasHtml ? "Start opens your HTML pages in a local preview." : "Open the folder containing your app or set a run command below. HTML pages can use the built-in preview."}</p>}
          {!savedProjectRunCommand && nestedPackages.length > 0 && <ul className="project-detected-folders" aria-label="Detected app folders">{nestedPackages.map((path) => <li key={path}>{path.slice(0, -"/package.json".length)}</li>)}</ul>}
        </div>
        <div className="project-run-heading"><span className={`project-status-dot ${projectStatus}`} aria-hidden="true" /><strong>{formatProjectStatus(projectStatus)}</strong></div>
        {projectActive && previewStatusLabel(props.project?.previewStartup) && <p className="project-preview-status" role="status">{previewStatusLabel(props.project?.previewStartup)}</p>}
        {startupError && <div className="project-start-error" role="alert"><p>{startupError}</p>{props.onViewLogs && <button className="button ghost compact" type="button" onClick={props.onViewLogs}>View logs</button>}</div>}
        <div className="project-sidebar-run-actions">
          <button className="button primary compact" type="button" onClick={() => props.onProjectAction("start")} disabled={props.busy || projectActive || autodetecting || projectRunCommandChanged}>{projectStatus === "starting" ? "Starting…" : projectStatus === "failed" ? "Retry start" : "Start"}</button>
          <button className="button danger compact" type="button" onClick={() => props.onProjectAction("stop")} disabled={props.busy || !projectActive || projectStatus === "stopping"}>{projectStatus === "stopping" ? "Stopping…" : "Stop"}</button>
          <button className="button ghost compact" type="button" onClick={() => props.onProjectAction("restart")} disabled={props.busy || !projectCanRestart || autodetecting || projectRunCommandChanged}>{projectStatus === "restarting" ? "Restarting…" : "Restart"}</button>
        </div>
        {projectRunCommandChanged && <p className="project-preview-status">Save your command or choose Auto-detect before starting.</p>}
        <details className="project-advanced"><summary>Run settings</summary><form onSubmit={(event) => { event.preventDefault(); props.onSaveProjectRunCommand(projectRunCommand.trim()); }}>
          <label htmlFor="sidebar-project-run-command">Run command</label>
          <input id="sidebar-project-run-command" type="text" value={projectRunCommand} maxLength={4096} onChange={(event) => { setProjectRunCommand(event.target.value); onRunCommandDirtyChange(event.target.value.trim() !== savedProjectRunCommand); }} placeholder="e.g. npm run dev" disabled={selectionDisabled || projectActive} spellCheck={false} />
          <p className="project-preview-status">Auto-detect checks the project again and replaces your custom command.</p>
          <div className="project-command-actions">
            <button className="button ghost compact" type="button" onClick={() => void autodetectProjectRunCommand()} disabled={selectionDisabled || projectActive || autodetecting}>{autodetecting ? "Detecting…" : "Auto-detect"}</button>
            <button className="button primary compact" type="submit" disabled={selectionDisabled || projectActive || autodetecting || !projectRunCommand.trim() || !projectRunCommandChanged}>Save</button>
          </div>
        </form></details>
      </section>}

      <section className="recent-projects" aria-labelledby="recent-projects-heading">
        <header><h2 id="recent-projects-heading">Project history</h2><span>{historicalProjects.length}</span></header>
        {!historicalProjects.length ? <p>Previously opened projects will appear here.</p> : <ul className="project-history-list">
          {historicalProjects.map((project) => <li className={project.pinned ? "pinned" : ""} key={project.path}>
            <button className="recent-project-select" type="button" onClick={() => props.onSelectRecentProject(project)} disabled={selectionDisabled} title={project.path}>
              <UiIcon name="projects" /><span><strong>{project.name}</strong><small>{project.pinned ? "Pinned project" : "Recent project"}</small></span>
            </button>
            <button className="recent-project-pin" type="button" onClick={() => props.onToggleProjectPinned(project)} disabled={props.busy} aria-label={`${project.pinned ? "Unpin" : "Pin"} ${project.name}`} aria-pressed={project.pinned} title={project.pinned ? "Unpin project" : "Pin project"}><UiIcon name="pin" /></button>
            <button className="recent-project-remove" type="button" onClick={() => props.onRemoveRecentProject(project)} disabled={props.busy} aria-label={`Remove ${project.name} from history`} title="Remove from history"><UiIcon name="close" /></button>
          </li>)}
        </ul>}
      </section>

    </div>
  </section>;
}

function formatProjectStatus(status: DesktopProject["status"]): string {
  if (status === "starting") return "Starting project";
  if (status === "running") return "Project running";
  if (status === "restarting") return "Restarting project";
  if (status === "stopping") return "Stopping project";
  if (status === "failed") return "Project stopped with an error";
  return "Project stopped";
}
