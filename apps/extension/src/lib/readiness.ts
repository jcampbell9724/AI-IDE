export type ReadinessTargetTab = "Chat" | "Project" | "Models" | "Connections" | "Settings";

export type ReadinessStepId = "token" | "daemon" | "model" | "project" | "page";

export interface ReadinessInput {
  daemonConnected: boolean;
  token?: string | null;
  selectedModel?: string | null;
  projectPath?: string | null;
  activeTabUrl?: string | null;
  contentReady: boolean;
}

export interface ReadinessStep {
  id: ReadinessStepId;
  label: string;
  complete: boolean;
  actionLabel: string;
  targetTab: ReadinessTargetTab;
}

export interface ReadinessState {
  ready: boolean;
  completed: number;
  total: number;
  summary: string;
  steps: ReadinessStep[];
  nextStep: ReadinessStep | undefined;
  nextTargetTab: ReadinessTargetTab | undefined;
}

function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

export function isSupportedActiveTabUrl(value: string | null | undefined): boolean {
  if (!hasText(value)) return false;

  try {
    const url = new URL(value as string);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function deriveReadiness(input: ReadinessInput): ReadinessState {
  const hasActivePage = isSupportedActiveTabUrl(input.activeTabUrl);
  const steps: ReadinessStep[] = [
    {
      id: "token",
      label: "Local access token saved",
      complete: hasText(input.token),
      actionLabel: "Add your daemon token",
      targetTab: "Settings",
    },
    {
      id: "daemon",
      label: "Local daemon connected",
      complete: input.daemonConnected,
      actionLabel: "Check the daemon connection",
      targetTab: "Connections",
    },
    {
      id: "model",
      label: "AI model selected",
      complete: hasText(input.selectedModel),
      actionLabel: "Choose a model",
      targetTab: "Models",
    },
    {
      id: "project",
      label: "Project folder selected",
      complete: hasText(input.projectPath),
      actionLabel: "Select your project",
      targetTab: "Project",
    },
    {
      id: "page",
      label: "Current page connected",
      complete: hasActivePage && input.contentReady,
      actionLabel: hasActivePage ? "Reconnect the current page" : "Open a web page to work on",
      targetTab: "Connections",
    },
  ];

  const completed = steps.filter((step) => step.complete).length;
  const nextStep = steps.find((step) => !step.complete);
  const remaining = steps.length - completed;

  return {
    ready: remaining === 0,
    completed,
    total: steps.length,
    summary: remaining === 0
      ? "Ready to build"
      : `${remaining} setup ${remaining === 1 ? "step" : "steps"} remaining`,
    steps,
    nextStep,
    nextTargetTab: nextStep?.targetTab,
  };
}
