import type { ElementContext, ProjectInfo } from "./types";

const SHORT_TEXT_LIMIT = 60;

function cleanText(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

export function friendlyElementLabel(element: ElementContext): string {
  const ariaLabel = cleanText(element.attributes["aria-label"]);
  if (ariaLabel) return ariaLabel;

  const visibleText = cleanText(element.text);
  if (visibleText && visibleText.length <= SHORT_TEXT_LIMIT) return visibleText;

  const id = cleanText(element.attributes.id);
  if (id) return `#${id}`;

  const firstClass = cleanText(element.attributes.class).split(" ").find(Boolean);
  if (firstClass) return `.${firstClass}`;

  return element.tagName.toLowerCase() || "element";
}

const TOOL_LABELS: Readonly<Record<string, string>> = {
  fs_list: "List project files",
  fs_read: "Read file",
  fs_search: "Search project",
  fs_replace: "Edit file",
  fs_write: "Write file",
  git_status: "Check Git status",
  git_diff: "Review changes",
  git_log: "Read Git history",
  shell_run: "Run command",
  browser: "Use browser",
};

export function friendlyToolName(toolId: string): string {
  const normalized = toolId.trim();
  if (!normalized) return "Tool";

  const known = TOOL_LABELS[normalized.toLowerCase()];
  if (known) return known;

  const words = normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Tool";
}

export function friendlyProjectStatus(project: Pick<ProjectInfo, "path" | "status">): string {
  const selected = Boolean(project.path?.trim());

  if (!selected && (project.status === "unknown" || project.status === "stopped")) {
    return "No project selected";
  }

  if (selected && project.status === "stopped") return "Selected — not managed here";

  switch (project.status) {
    case "running":
      return "Running";
    case "starting":
      return "Starting…";
    case "restarting":
      return "Restarting…";
    case "stopping":
      return "Stopping…";
    case "failed":
    case "error":
      return "Needs attention";
    case "unknown":
      return selected ? "Selected — status unavailable" : "No project selected";
    case "stopped":
      return "Stopped";
  }
}
