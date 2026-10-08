import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
const sidebar = await readFile(new URL("./project-sidebar.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");
const contracts = await readFile(new URL("../../shared/contracts.ts", import.meta.url), "utf8");
const main = await readFile(new URL("../../main/index.ts", import.meta.url), "utf8");

describe("desktop project sidepane", () => {
  it("gives the project directory and project manager separate sidepane buttons", () => {
    expect(app).toContain('className="labeled-navigation" aria-label="Main navigation"');
    expect(app).toContain('["projects", "chats", "files"] as const');
    expect(app).toContain('setSettingsOpen(false); setSidebarTab(tab); setHistoryOpen(true);');
    expect(app).toMatch(/id="project-directory"[\s\S]*?<ProjectDirectory/);
    expect(app).toMatch(/id="project-manager"[\s\S]*?<ProjectSidebar/);
    expect(sidebar).toContain('aria-label="Projects"');
    expect(sidebar).toContain("Open project");
    expect(sidebar).toContain("Create new project");
    expect(sidebar).toContain('id="sidebar-project-run-command"');
    expect(app).not.toContain('id="settings-tab-project"');
  });

  it("shows prior projects immediately after the create-project flow", () => {
    const createButton = sidebar.indexOf("Create new project");
    const recentSection = sidebar.indexOf('className="recent-projects"');

    expect(createButton).toBeGreaterThan(-1);
    expect(recentSection).toBeGreaterThan(createButton);
    expect(sidebar).toContain("Previously opened projects will appear here.");
    expect(sidebar).toContain(".filter((project) => project.path !== projectPath)");
  });

  it("exposes canonical recent-project history and restores saved project details", () => {
    expect(contracts).toContain("readonly recentProjects: readonly DesktopRecentProject[]");
    expect(main).toContain("recentProjects: projectState.recent.map");
    expect(main).toContain("devCommand: project.devCommand");
    expect(main).toContain("url: project.url");
    expect(main).toContain("pinned: projectState.pinned.includes(project.root)");
    expect(app).toContain("window.browserAgent.selectProject({");
    expect(app).toContain("path: recentProject.path");
    expect(app).not.toContain("devCommand: recentProject.devCommand");
    expect(app).not.toContain("url: recentProject.url");
  });

  it("shows all project history in a scrollable list with pin and remove controls", () => {
    expect(styles).toMatch(/\.project-history-list\s*\{[^}]*overflow-y:\s*auto/);
    expect(sidebar).not.toMatch(/historicalProjects\.slice\(/);
    expect(sidebar).toContain('className="recent-project-pin"');
    expect(sidebar).toContain('className="recent-project-remove"');
    expect(sidebar).toContain("Number(right.pinned) - Number(left.pinned)");
    expect(app).toContain("window.browserAgent.removeRecentProject(project.path)");
    expect(app).toContain("window.browserAgent.setProjectPinned(project.path, !project.pinned)");
  });
});
