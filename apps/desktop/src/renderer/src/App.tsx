import { UiIcon } from "./ui-icon";
import spanMark from "./assets/span-mark.png";
import spanThinking from "./assets/span-thinking.gif";
import spanThinkingStill from "./assets/span-thinking-still.png";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import type { AgentEvent, AgentRunRequest, OpenRouterModel } from "@browser-agent/shared";
import type { DesktopProjectDirectory, DesktopRecentProject, DesktopSnapshot } from "../../shared/contracts";
import { renderMarkdown } from "./markdown";
import { PreviewStatus, previewShowsStatus, previewStatusLabel } from "./preview-status";
import { ProjectLogs } from "./project-logs";
import { ModelFacts, ModelSuggestion, filterModels } from "./model-info";
import { prepareChatSubmission, prepareEditedMessage } from "./chat-submission";
import { CopyButton } from "./copy-button";
import { RenameChat } from "./chat-history-controls";
import { canRetryRun, prepareRunRetry, trackRecoveryEvent, type ChatSubmission, type FailedRun, type RunAttempt } from "./run-recovery";
import { emptyWorkspaceView, loadWorkspaceView, saveWorkspaceView } from "./workspace-memory";
import { applyAssistantTextEvent, applyCompletedAssistantText } from "./message-stream";
import {
  beginRunProgress,
  IDLE_RUN_PROGRESS,
  isEventForActiveRun,
  markRunStopping,
  progressFromEvent,
} from "./run-progress";
import {
  createChat,
  createEmptyChatHistory,
  deleteChat,
  getActiveChat,
  getComposerDraft,
  updateComposerDraft,
  loadFavoriteModels,
  loadProjectChatHistory,
  saveFavoriteModels,
  saveProjectChatHistory,
  selectChat,
  renameChat,
  searchChats,
  updateActiveChat,
  type PersistedChatHistory,
  type PersistedMessage,
  type PersistedTool,
} from "./persist";
import { applyToolEvent, settlePendingTools } from "./tool-state";
import {
  browserBoundsFromRect,
  chatPanePercentFromPointer,
  chatPanePercentForWidth,
  COMPACT_WORKSPACE_PIXELS,
  OVERLAY_SIDEBAR_PIXELS,
  clampStoredChatPanePercent,
  DEFAULT_CHAT_PANE_PERCENT,
} from "./pane-layout";
import { describeAgentError, type AgentErrorInfo } from "./format";
import { CodeViewer, fileName, ProjectDirectory, type CodeViewState } from "./project-browser";
import { ProjectSidebar } from "./project-sidebar";
import { CodebaseMapSettings } from "./codebase-map/CodebaseMapSettings";
import { RunReportPanel } from "./run-report/RunReportPanel";
import { loadRunReports, prependRunReport, reportFromEvent, saveRunReports, type RunReport } from "./run-report/store";

const MAX_MESSAGE_CHARACTERS = 50_000;
const CHAT_PANE_STORAGE_KEY = "browser-agent.chat-pane-percent";
const HIDDEN_BROWSER_BOUNDS = { x: 0, y: 0, width: 0, height: 0, visible: false } as const;
const EMPTY_STATE_PHRASES = [
  "What deserves your focus?",
  "Turn your plan into progress.",
  "Let's make today count.",
  "Ready to move the work forward?",
  "One clear goal. What's yours?",
  "Focus in. Make it happen.",
  "What are we getting done?",
  "Small steps. Real progress.",
] as const;

function phraseForConversation(conversationId: string): string {
  let hash = 0;
  for (const character of conversationId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return EMPTY_STATE_PHRASES[hash % EMPTY_STATE_PHRASES.length]!;
}

type Message = PersistedMessage;
type ToolItem = PersistedTool;

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [error, setError] = useState<AgentErrorInfo | null>(null);
  const [failedRun, setFailedRun] = useState<FailedRun | null>(null);
  const [settingsDestination, setSettingsDestination] = useState<{ tab: SettingsTab | null; version: number }>({ tab: null, version: 0 });
  const [notice, setNotice] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);
  const [projectRunCommandDirty, setProjectRunCommandDirty] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<OpenRouterModel[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState(IDLE_RUN_PROGRESS);
  const [runReports, setRunReports] = useState<RunReport[]>([]);
  const [runReportStorageWarning, setRunReportStorageWarning] = useState(false);
  const [chatHistory, setChatHistory] = useState<PersistedChatHistory>(() => createEmptyChatHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatSearch, setChatSearch] = useState("");
  const [sidebarTab, setSidebarTab] = useState<"chats" | "files" | "projects" | "models">("chats");
  const [projectDirectory, setProjectDirectory] = useState<DesktopProjectDirectory | null>(null);
  const [projectDirectoryLoading, setProjectDirectoryLoading] = useState(false);
  const [projectDirectoryError, setProjectDirectoryError] = useState("");
  const [codeViews, setCodeViews] = useState<CodeViewState[]>([]);
  const [activeCodePath, setActiveCodePath] = useState<string | null>(null);
  const [projectLogsOpen, setProjectLogsOpen] = useState(false);
  const [previewActionError, setPreviewActionError] = useState("");
  const [chatPanePercent, setChatPanePercent] = useState(loadChatPanePercent);
  const [resizingPane, setResizingPane] = useState(false);
  const [compactView, setCompactView] = useState<"chat" | "preview">("chat");
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [panesWidth, setPanesWidth] = useState(0);
  const compactWorkspace = windowWidth <= COMPACT_WORKSPACE_PIXELS;
  const overlaySidebar = windowWidth <= OVERLAY_SIDEBAR_PIXELS;
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const activeChat = getActiveChat(chatHistory);
  const composer = getComposerDraft(chatHistory);
  const messages = activeChat?.messages ?? [];
  const tools = activeChat?.tools ?? [];
  const emptyStatePhrase = activeChat ? phraseForConversation(activeChat.id) : "";
  const activeCodeView = codeViews.find((view) => view.path === activeCodePath) ?? null;
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const panesRef = useRef<HTMLElement | null>(null);
  const [pickingElement, setPickingElement] = useState(false);
  const browserViewportRef = useRef<HTMLDivElement | null>(null);
  const browserBoundsFrameRef = useRef(0);
  const browserRequestedVisibleRef = useRef(false);
  const paneResizePointerRef = useRef<number | null>(null);
  const paneResizeValueRef = useRef(chatPanePercent);
  const paneResizeActiveRef = useRef(false);
  const shouldFollowChat = useRef(true);
  const assistantId = useRef("");
  const assistantStreamFrameRef = useRef(0);
  const pendingAssistantDeltaRef = useRef("");
  const activeRunIdRef = useRef("");
  const projectSelectionRef = useRef(false);
  const projectActionRef = useRef(false);
  const projectRunCommandDirtyRef = useRef(false);
  const runAttemptRef = useRef<RunAttempt | null>(null);
  const chatHistoryRef = useRef(chatHistory);
  const chatProjectPathRef = useRef<string | null>(null);
  const loadedProjectPathRef = useRef<string | null>(null);
  const runReportsRef = useRef<RunReport[]>([]);
  const workspaceViewRef = useRef(emptyWorkspaceView());
  const workspaceSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [workspaceOwner, setWorkspaceOwner] = useState<string | null>(null);
  const projectFileRequestSequenceRef = useRef(0);
  const projectFileRequestsRef = useRef(new Map<string, number>());
  const lastSyncedPreviewUrlRef = useRef("");
  const lastPreviewProjectRef = useRef<string | null>(null);

  const onRunCommandDirtyChange = useCallback((dirty: boolean): void => {
    projectRunCommandDirtyRef.current = dirty;
    setProjectRunCommandDirty(dirty);
  }, []);

  const setMessages = useCallback((update: Message[] | ((current: Message[]) => Message[])): void => {
    setChatHistory((current) => {
      const currentMessages = getActiveChat(current)?.messages ?? [];
      const nextMessages = typeof update === "function" ? update(currentMessages) : update;
      return updateActiveChat(current, { messages: nextMessages });
    });
  }, []);

  const setTools = useCallback((update: ToolItem[] | ((current: ToolItem[]) => ToolItem[])): void => {
    setChatHistory((current) => {
      const currentTools = getActiveChat(current)?.tools ?? [];
      const nextTools = typeof update === "function" ? update(currentTools) : update;
      return updateActiveChat(current, { tools: nextTools });
    });
  }, []);

  const flushPendingAssistantText = useCallback((): void => {
    if (assistantStreamFrameRef.current) {
      window.cancelAnimationFrame(assistantStreamFrameRef.current);
      assistantStreamFrameRef.current = 0;
    }
    const delta = pendingAssistantDeltaRef.current;
    const targetId = assistantId.current;
    pendingAssistantDeltaRef.current = "";
    if (!delta || !targetId) return;
    setMessages((current) => current.map((message) => message.id === targetId
      ? { ...message, content: `${message.content}${delta}` }
      : message));
  }, [setMessages]);

  const discardPendingAssistantText = useCallback((): void => {
    if (assistantStreamFrameRef.current) {
      window.cancelAnimationFrame(assistantStreamFrameRef.current);
      assistantStreamFrameRef.current = 0;
    }
    pendingAssistantDeltaRef.current = "";
  }, []);

  const showError = useCallback((caught: unknown, code?: string, operation?: "models") => {
    setNotice("");
    setError({ ...describeAgentError(code, caught instanceof Error ? caught.message : String(caught)), ...(operation ? { operation } : {}) });
  }, []);

  const showNotice = useCallback((message: string) => {
    setError(null);
    setNotice(message);
  }, []);

  useEffect(() => {
    chatHistoryRef.current = chatHistory;
    const projectPath = chatProjectPathRef.current;
    if (!projectPath) return;
    const timer = window.setTimeout(() => saveProjectChatHistory(projectPath, chatHistory), 250);
    return () => window.clearTimeout(timer);
  }, [chatHistory]);

  useEffect(() => {
    const flushHistory = (): void => {
      saveProjectChatHistory(chatProjectPathRef.current, chatHistoryRef.current);
    };
    window.addEventListener("pagehide", flushHistory);
    return () => {
      window.removeEventListener("pagehide", flushHistory);
      flushHistory();
    };
  }, []);

  useEffect(() => () => discardPendingAssistantText(), [discardPendingAssistantText]);

  const scheduleWorkspaceSave = useCallback((): void => {
    clearTimeout(workspaceSaveTimer.current);
    workspaceSaveTimer.current = setTimeout(() => {
      saveWorkspaceView(loadedProjectPathRef.current, workspaceViewRef.current);
    }, 250);
  }, []);

  useEffect(() => {
    const flush = (): void => {
      clearTimeout(workspaceSaveTimer.current);
      saveWorkspaceView(loadedProjectPathRef.current, workspaceViewRef.current);
    };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);

  useEffect(() => {
    void window.browserAgent.getSnapshot().then(setSnapshot).catch(showError);
    const removeSnapshot = window.browserAgent.onSnapshot(setSnapshot);
    const removeEvents = window.browserAgent.onAgentEvent(handleAgentEvent);
    const poll = window.setInterval(() => {
      void window.browserAgent.getSnapshot().then(setSnapshot).catch(() => undefined);
    }, 2500);
    return () => {
      removeSnapshot();
      removeEvents();
      window.clearInterval(poll);
    };
  }, [showError]);

  const previewFailure = previewActionError || (snapshot?.browser.error ? "The preview could not load. Start the project or check its local address, then try again." : "") || (snapshot?.project.status === "failed" ? snapshot.project.error || "The project stopped unexpectedly. Check its logs, then start it again." : "");
  const previewStatus = previewFailure ? { phase: "failed" as const, message: previewFailure } : snapshot?.project.previewStartup;
  const showPreviewStatus = previewShowsStatus(previewStatus);
  browserRequestedVisibleRef.current = Boolean(snapshot?.browser.url) && !showPreviewStatus && !resizingPane && activeCodePath === null
    && !settingsOpen && (!compactWorkspace || compactView === "preview") && !(overlaySidebar && historyOpen);

  useLayoutEffect(() => {
    const panes = panesRef.current;
    if (!panes) return;
    const measure = (): void => {
      setWindowWidth(window.innerWidth);
      setPanesWidth(panes.getBoundingClientRect().width);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panes);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  const scheduleBrowserBounds = useCallback((): void => {
    window.cancelAnimationFrame(browserBoundsFrameRef.current);
    browserBoundsFrameRef.current = window.requestAnimationFrame(() => {
      if (paneResizeActiveRef.current) return;
      const viewport = browserViewportRef.current;
      if (!viewport) return;
      const bounds = browserBoundsFromRect(
        viewport.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
        browserRequestedVisibleRef.current,
      );
      void window.browserAgent.setBrowserBounds(bounds).catch(() => undefined);
    });
  }, []);

  useLayoutEffect(() => {
    const viewport = browserViewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(scheduleBrowserBounds);
    observer.observe(viewport);
    window.addEventListener("resize", scheduleBrowserBounds);
    scheduleBrowserBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleBrowserBounds);
      window.cancelAnimationFrame(browserBoundsFrameRef.current);
      void window.browserAgent.setBrowserBounds(HIDDEN_BROWSER_BOUNDS).catch(() => undefined);
    };
  }, [scheduleBrowserBounds]);

  useEffect(() => {
    scheduleBrowserBounds();
  }, [settingsOpen, activeCodePath, resizingPane, scheduleBrowserBounds, snapshot?.browser.url, showPreviewStatus, compactWorkspace, compactView, overlaySidebar, historyOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CHAT_PANE_STORAGE_KEY, String(chatPanePercent));
    } catch {
      // Resizing still works when persistent renderer storage is unavailable.
    }
  }, [chatPanePercent]);

  useLayoutEffect(() => {
    const textarea = composerRef.current;
    if (!textarea || (compactWorkspace && compactView !== "chat")) return;
    textarea.style.height = "0px";
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(180, Math.max(52, contentHeight))}px`;
    textarea.style.overflowY = contentHeight > 180 ? "auto" : "hidden";

    if (shouldFollowChat.current) {
      const viewport = chatScrollRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    }
  }, [composer, settingsOpen, compactWorkspace, compactView, panesWidth, chatPanePercent, historyOpen]);

  useEffect(() => {
    if (!shouldFollowChat.current) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = chatScrollRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, runProgress.phase, tools]);

  useEffect(() => {
    if (!historyOpen) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !isNarrowWindow()) return;
      setHistoryOpen(false);
      window.requestAnimationFrame(() => sidebarToggleRef.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [historyOpen]);

  useEffect(() => {
    const projectPath = snapshot?.project.path ?? null;
    if (loadedProjectPathRef.current === projectPath) return;
    onRunCommandDirtyChange(false);
    clearTimeout(workspaceSaveTimer.current);
    saveWorkspaceView(loadedProjectPathRef.current, workspaceViewRef.current);
    const restoredView = projectPath ? loadWorkspaceView(projectPath) : emptyWorkspaceView();
    workspaceViewRef.current = restoredView;
    setWorkspaceOwner(projectPath);
    saveProjectChatHistory(chatProjectPathRef.current, chatHistoryRef.current);
    chatProjectPathRef.current = projectPath;
    setChatSearch("");
    const projectHistory = loadProjectChatHistory(projectPath);
    const restoredReports = loadRunReports(projectPath);
    runReportsRef.current = restoredReports;
    setRunReports(restoredReports);
    setRunReportStorageWarning(false);
    chatHistoryRef.current = projectHistory;
    setChatHistory(projectHistory);
    resetChatView();
    loadedProjectPathRef.current = projectPath;
    projectFileRequestsRef.current.clear();
    setProjectDirectory(null);
    setProjectDirectoryLoading(false);
    setProjectDirectoryError("");
    setCodeViews(restoredView.files.map((path) => ({ path, loading: false })));
    setActiveCodePath(restoredView.activeFile);
    setSidebarTab(restoredView.sidebar);
    setHistoryOpen(restoredView.sidebarOpen);
    setProjectLogsOpen(false);
    setPreviewActionError("");
  }, [snapshot?.project.path, onRunCommandDirtyChange]);

  useEffect(() => {
    if (!workspaceOwner || workspaceOwner !== snapshot?.project.path) return;
    workspaceViewRef.current = { ...workspaceViewRef.current,
      files: codeViews.map((view) => view.path), activeFile: activeCodePath,
      sidebar: sidebarTab, sidebarOpen: historyOpen,
    };
    scheduleWorkspaceSave();
  }, [workspaceOwner, snapshot?.project.path, codeViews, activeCodePath, sidebarTab, historyOpen, scheduleWorkspaceSave]);

  useEffect(() => {
    if (!workspaceOwner || workspaceOwner !== snapshot?.project.path || !activeCodePath) return;
    const view = codeViews.find((candidate) => candidate.path === activeCodePath);
    if (view && !view.file && !view.loading && !view.error) void openProjectFile(activeCodePath);
  }, [workspaceOwner, snapshot?.project.path, activeCodePath, codeViews]);

  useLayoutEffect(() => {
    if (!activeChat || workspaceOwner !== snapshot?.project.path) return;
    const viewport = chatScrollRef.current;
    if (!viewport) return;
    const saved = workspaceViewRef.current.chatScroll[activeChat.id];
    shouldFollowChat.current = saved === undefined;
    viewport.scrollTop = saved ?? viewport.scrollHeight;
    setShowScrollToLatest(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight >= 72);
  }, [activeChat?.id, workspaceOwner, snapshot?.project.path, settingsOpen]);

  useEffect(() => {
    const synced = snapshot?.browser.url || snapshot?.project.url || "";
    const projectPath = snapshot?.project.path ?? null;
    const projectChanged = projectPath !== lastPreviewProjectRef.current;
    lastPreviewProjectRef.current = projectPath;
    if (projectChanged) {
      lastSyncedPreviewUrlRef.current = synced;
      setPreviewUrl(synced);
      return;
    }
    // Do not clobber typing: only adopt the snapshot URL when the input still
    // holds the last synced value (or is empty and a URL just appeared).
    const previousSynced = lastSyncedPreviewUrlRef.current;
    lastSyncedPreviewUrlRef.current = synced;
    if (synced === previousSynced) return;
    setPreviewUrl((current) => (current === previousSynced || current === "" ? synced : current));
  }, [snapshot?.project.path, snapshot?.project.url, snapshot?.browser.url]);

  useEffect(() => {
    if (
      historyOpen
      && sidebarTab === "files"
      && snapshot?.project.path
      && !projectDirectory
      && !projectDirectoryLoading
      && !projectDirectoryError
    ) {
      void refreshProjectDirectory();
    }
  }, [historyOpen, projectDirectory, projectDirectoryError, projectDirectoryLoading, sidebarTab, snapshot?.project.path]);

  const missingSetup = useMemo(() => {
    if (!snapshot) return "loading" as const;
    if (!snapshot.project.path) return "project" as const;
    if (!snapshot.preferences.apiKeyConfigured) return "provider" as const;
    if (!snapshot.preferences.selectedModel) return "model" as const;
    return null;
  }, [snapshot]);
  const chatReady = missingSetup === null;

  function handleAgentEvent(event: AgentEvent): void {
    if (!isEventForActiveRun(activeRunIdRef.current, event)) return;
    recordRunReport(event);
    if (runAttemptRef.current) trackRecoveryEvent(runAttemptRef.current, event);
    setRunProgress((current) => progressFromEvent(current, event));
    if (event.type === "assistant.delta") {
      pendingAssistantDeltaRef.current += event.delta;
      if (!assistantStreamFrameRef.current) {
        assistantStreamFrameRef.current = window.requestAnimationFrame(() => {
          assistantStreamFrameRef.current = 0;
          flushPendingAssistantText();
        });
      }
    }
    if (event.type === "assistant.message") {
      discardPendingAssistantText();
      setMessages((current) => applyAssistantTextEvent(current, assistantId.current, event));
    }
    if (["tool.started", "tool.finished", "approval.required", "approval.resolved"].includes(event.type)) {
      setTools((current) => applyToolEvent(current, event));
    }
    if (event.type === "run.error") {
      flushPendingAssistantText();
      removeEmptyAssistant();
      setTools((current) => settlePendingTools(current, "Run ended before this activity completed."));
      finishRun();
      recordRunFailure(event.error, event.code, true);
    }
    if (event.type === "run.cancelled") {
      flushPendingAssistantText();
      removeEmptyAssistant();
      setTools((current) => settlePendingTools(current, "Stopped before this activity completed."));
      finishRun();
      showNotice("Task stopped.");
    }
    if (event.type === "run.completed") {
      discardPendingAssistantText();
      setMessages((current) => applyCompletedAssistantText(current, assistantId.current, event.content));
      setTools((current) => settlePendingTools(current, "The response finished before this activity reported a result."));
      finishRun();
    }
  }

  function finishRun(): void {
    setRunning(false);
    activeRunIdRef.current = "";
  }

  function recordRunReport(event: AgentEvent): void {
    const report = reportFromEvent(event);
    const projectPath = runAttemptRef.current?.projectPath;
    if (!report || !projectPath) return;
    const previous = projectPath === loadedProjectPathRef.current ? runReportsRef.current : loadRunReports(projectPath);
    updateRunReports(projectPath, prependRunReport(previous, report));
  }

  function updateRunReports(projectPath: string | null, reports: RunReport[]): void {
    if (!projectPath) return;
    const saved = saveRunReports(projectPath, reports);
    if (projectPath !== loadedProjectPathRef.current) return;
    runReportsRef.current = reports;
    setRunReports(reports);
    setRunReportStorageWarning(!saved);
  }

  function removeEmptyAssistant(): void {
    setMessages((current) => current.filter((message) => message.id !== assistantId.current || Boolean(message.content.trim())));
  }

  async function submitChat(event: FormEvent): Promise<void> {
    event.preventDefault();
    const content = composer.trim();
    if (!content || activeRunIdRef.current || running || setupBusy || !snapshot) return;
    if (!chatReady || loadedProjectPathRef.current !== snapshot.project.path) {
      showError(new Error("Choose a project and select a model before sending a message."));
      return;
    }

    const submission = prepareChatSubmission(chatHistory, content);
    if (!submission) return;
    await runChatSubmission(submission);
  }

  async function runChatSubmission(submission: ChatSubmission): Promise<void> {
    if (!snapshot || !chatReady || running || setupBusy || activeRunIdRef.current) return;
    const { requestMessages } = submission;
    const chat = getActiveChat(submission.history)!;
    const user = requestMessages.at(-1)!;
    runAttemptRef.current = { projectPath: snapshot.project.path!, chatId: chat.id, assistantId: submission.assistantId,
      userMessageId: user.id, prompt: user.content, activity: false, output: false };
    setFailedRun(null);
    setSettingsOpen(false);
    const runId = crypto.randomUUID();
    assistantId.current = submission.assistantId;
    activeRunIdRef.current = runId;
    shouldFollowChat.current = true;
    setShowScrollToLatest(false);
    discardPendingAssistantText();
    chatHistoryRef.current = submission.history;
    setChatHistory(submission.history);
    setRunning(true);
    setRunProgress(beginRunProgress(snapshot.preferences.selectedModel));
    setError(null);
    setNotice("");

    const request: AgentRunRequest = {
      runId,
      sessionId: submission.sessionId,
      model: snapshot.preferences.selectedModel,
      messages: requestMessages.map((message) => ({ role: message.role, content: message.content })),
      context: {
        elements: [],
        visualChanges: [],
        attachments: [{
          kind: "desktop-browser",
          url: snapshot.browser.url || null,
          title: snapshot.browser.title || null,
        }],
        ...(snapshot.project.path ? { projectRoot: snapshot.project.path } : {}),
        ...(snapshot.browser.url ? { activeTab: { url: snapshot.browser.url, title: snapshot.browser.title || snapshot.browser.url } } : {}),
      },
      approvalMode: snapshot.preferences.approvalMode,
    };

    try {
      await window.browserAgent.runAgent(request);
    } catch (caught) {
      if (activeRunIdRef.current !== runId) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      setRunProgress((current) => progressFromEvent(current, {
        type: "run.error",
        runId,
        timestamp: new Date().toISOString(),
        error: message,
      }));
      removeEmptyAssistant();
      setTools((current) => settlePendingTools(current, "Run ended before this activity completed."));
      finishRun();
      recordRunFailure(message, undefined, false);
    }
  }

  function recordRunFailure(message: string, code: string | undefined, confirmedEnded: boolean): void {
    const info = describeAgentError(code, message);
    setNotice(""); setError(info);
    setFailedRun(runAttemptRef.current ? { ...runAttemptRef.current, error: info, confirmedEnded } : null);
  }

  function dismissFeedback(): void {
    setError(null); setNotice(""); setFailedRun(null);
  }

  function openRecoverySettings(tab: "api-key" | "model"): void {
    setCompactView("chat");
    if (isNarrowWindow()) setHistoryOpen(false);
    setSettingsDestination((current) => ({ tab, version: current.version + 1 }));
    setSettingsOpen(true);
    if (tab === "model" && !availableModels.length) void loadAvailableModels();
  }

  function markRecoverySettingsUpdated(): void {
    setFailedRun((current) => current ? { ...current, error: { ...current.error, title: "Ready to try again", detail: "Your settings were updated. Review the request or retry when you’re ready.", retryable: true } } : null);
  }

  function recoveryActions(info: AgentErrorInfo | null): ReactElement | undefined {
    if (!info) return undefined;
    const failure = info === failedRun?.error ? failedRun : null;
    const retryAllowed = failure && canRetryRun(failure, chatHistory, snapshot?.project.path ?? null);
    const busy = running || setupBusy || modelsBusy;
    return <div className="error-recovery">
      <div className="error-recovery-buttons">
        {retryAllowed && <button className="button primary" type="button" disabled={busy || !chatReady} onClick={() => {
          const retry = prepareRunRetry(failure, chatHistory, snapshot?.project.path ?? null);
          if (retry) void runChatSubmission(retry);
        }}>Retry request</button>}
        {info.operation === "models" && <button className="button ghost" type="button" disabled={busy} onClick={() => void loadAvailableModels(true)}>Reload models</button>}
        {info.recovery === "api-key" && <button className="button ghost" type="button" disabled={busy} onClick={() => openRecoverySettings("api-key")}>Review API key</button>}
        {info.recovery === "model" && <button className="button ghost" type="button" disabled={busy} onClick={() => openRecoverySettings("model")}>Choose another model</button>}
      </div>
      {failure && <details className="failed-request"><summary>Review request</summary>
        {failure.activity && <p>Activity already ran. Review the chat and tool activity before sending another request.</p>}
        {!failure.confirmedEnded && <p>The app could not confirm how the run ended. Review its state before sending again.</p>}
        <pre>{failure.prompt}</pre>
        <button className="button ghost" type="button" disabled={busy || Boolean(composer)} onClick={() => { setComposer(failure.prompt); focusComposer(); }}>Use as draft</button>
        {composer && <p>Your current draft is preserved. Clear or send it before loading this request.</p>}
      </details>}
    </div>;
  }

  function startNewChat(): void {
    if (running || !snapshot?.project.path) return;
    setSettingsOpen(false);
    setCompactView("chat");
    setChatHistory((current) => createChat(current));
    resetChatView();
    if (isNarrowWindow()) setHistoryOpen(false);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function focusComposer(): void {
    setCompactView("chat");
    setSettingsOpen(false);
    if (isNarrowWindow()) setHistoryOpen(false);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function showSavedChats(): void {
    setSidebarTab("chats"); setHistoryOpen(true);
  }

  function useStarterPrompt(prompt: string): void {
    if (composer || running) return;
    setComposer(prompt);
    focusComposer();
  }

  async function refreshProjectDirectory(): Promise<void> {
    if (!snapshot?.project.path || projectDirectoryLoading) return;
    const requestedProject = snapshot.project.path;
    setProjectDirectoryLoading(true);
    setProjectDirectoryError("");
    try {
      const directory = await window.browserAgent.listProjectDirectory();
      if (loadedProjectPathRef.current === requestedProject) setProjectDirectory(directory);
    } catch (caught) {
      if (loadedProjectPathRef.current === requestedProject) {
        setProjectDirectoryError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (loadedProjectPathRef.current === requestedProject) setProjectDirectoryLoading(false);
    }
  }

  async function openProjectFile(path: string): Promise<void> {
    setCompactView("preview");
    if (isNarrowWindow()) setHistoryOpen(false);
    setActiveCodePath(path);
    const existing = codeViews.find((view) => view.path === path);
    if (existing?.file || existing?.loading || projectFileRequestsRef.current.has(path)) return;

    const request = projectFileRequestSequenceRef.current + 1;
    projectFileRequestSequenceRef.current = request;
    projectFileRequestsRef.current.set(path, request);
    setCodeViews((current) => current.some((view) => view.path === path)
      ? current.map((view) => view.path === path ? { path, loading: true } : view)
      : [...current, { path, loading: true }]);
    try {
      const file = await window.browserAgent.readProjectFile(path);
      if (projectFileRequestsRef.current.get(path) === request) {
        setCodeViews((current) => current.map((view) => view.path === path
          ? { path, file, loading: false }
          : view));
      }
    } catch (caught) {
      if (projectFileRequestsRef.current.get(path) === request) {
        setCodeViews((current) => current.map((view) => view.path === path
          ? { path, loading: false, error: caught instanceof Error ? caught.message : String(caught) }
          : view));
      }
    } finally {
      if (projectFileRequestsRef.current.get(path) === request) projectFileRequestsRef.current.delete(path);
    }
  }

  function closeProjectFile(path: string): void {
    projectFileRequestsRef.current.delete(path);
    const tabIndex = codeViews.findIndex((view) => view.path === path);
    const fallbackPath = codeViews[tabIndex - 1]?.path ?? codeViews[tabIndex + 1]?.path ?? null;
    setCodeViews((current) => current.filter((view) => view.path !== path));
    setActiveCodePath((current) => current === path ? fallbackPath : current);
  }

  function openSavedChat(chatId: string): void {
    if (running) return;
    setCompactView("chat");
    setSettingsOpen(false);
    if (chatId !== chatHistory.activeChatId) {
      setChatHistory((current) => selectChat(current, chatId));
      resetChatView();
    }
    if (isNarrowWindow()) setHistoryOpen(false);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function removeSavedChat(chatId: string, title: string): void {
    if (running || !window.confirm(`Delete “${title}”? This cannot be undone.`)) return;
    const removedActiveChat = chatId === chatHistory.activeChatId;
    setChatHistory((current) => deleteChat(current, chatId));
    if (removedActiveChat) resetChatView();
  }

  function resetChatView(): void {
    setFailedRun(null);
    runAttemptRef.current = null;
    discardPendingAssistantText();
    assistantId.current = "";
    activeRunIdRef.current = "";
    shouldFollowChat.current = true;
    setShowScrollToLatest(false);
    setRunProgress(IDLE_RUN_PROGRESS);
    setError(null);
    setNotice("");
  }

  function setComposer(value: string): void {
    setChatHistory((current) => {
      const next = updateComposerDraft(current, value);
      chatHistoryRef.current = next;
      return next;
    });
  }

  function trackChatScroll(): void {
    const viewport = chatScrollRef.current;
    if (!viewport) return;
    if (activeChat && workspaceOwner === loadedProjectPathRef.current) {
      workspaceViewRef.current.chatScroll[activeChat.id] = viewport.scrollTop;
      scheduleWorkspaceSave();
    }
    const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72;
    shouldFollowChat.current = nearBottom;
    setShowScrollToLatest(!nearBottom);
  }

  function scrollChatToLatest(): void {
    const viewport = chatScrollRef.current;
    if (!viewport) return;
    shouldFollowChat.current = true;
    setShowScrollToLatest(false);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  }

  async function decide(tool: ToolItem, decision: "approve" | "reject"): Promise<void> {
    if (!tool.approvalId) return;
    try {
      const result = await window.browserAgent.decideApproval(tool.approvalId, decision);
      if (!result.resolved) throw new Error("That approval is no longer active.");
    } catch (caught) {
      showError(caught);
    }
  }

  async function stopRun(): Promise<void> {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    const previousProgress = runProgress;
    setRunProgress((current) => markRunStopping(current));
    try {
      const result = await window.browserAgent.cancelAgent(runId);
      if (!result.cancelled) throw new Error("The run could not be stopped. It may already be finishing.");
    } catch (caught) {
      if (activeRunIdRef.current !== runId) return;
      setRunProgress((current) => current.phase === "stopping" ? previousProgress : current);
      showError(caught);
    }
  }

  async function saveProvider(): Promise<void> {
    if (!apiKey.trim()) return;
    setSetupBusy(true);
    let providerSaved = false;
    try {
      const next = await window.browserAgent.savePreferences({ apiKey: apiKey.trim() });
      setSnapshot(next);
      setApiKey("");
      providerSaved = true;
      const result = await window.browserAgent.listModels(true);
      const toolModels = result.models.filter((model) => model.supportsTools !== false);
      setAvailableModels(toolModels);
      showNotice("API key saved.");
      markRecoverySettingsUpdated();
    } catch (caught) {
      showError(caught, undefined, providerSaved ? "models" : undefined);
    } finally {
      setSetupBusy(false);
    }
  }

  async function chooseDefaultModel(): Promise<void> {
    openRecoverySettings("model");
  }

  async function loadAvailableModels(refresh = false): Promise<void> {
    if (!snapshot?.preferences.apiKeyConfigured || modelsBusy) return;
    setModelsBusy(true);
    try {
      const result = await window.browserAgent.listModels(refresh);
      setAvailableModels(result.models.filter((model) => model.supportsTools !== false));
      if (error?.operation === "models") { setError(null); showNotice("Models refreshed."); }
    } catch (caught) {
      showError(caught, undefined, "models");
    } finally {
      setModelsBusy(false);
    }
  }

  async function saveSelectedModel(model: string): Promise<void> {
    if (!model || setupBusy || activeRunIdRef.current) return;
    setSetupBusy(true);
    try {
      setSnapshot(await window.browserAgent.savePreferences({ selectedModel: model }));
      showNotice("Model updated.");
      markRecoverySettingsUpdated();
    } catch (caught) {
      showError(caught);
    } finally {
      setSetupBusy(false);
    }
  }

  async function saveRepositoryMemoryEnabled(enabled: boolean): Promise<void> {
    if (setupBusy) return;
    setSetupBusy(true);
    try {
      setSnapshot(await window.browserAgent.savePreferences({ repositoryMemoryEnabled: enabled }));
      showNotice(`Repository memory ${enabled ? "enabled" : "disabled"}.`);
    } catch (caught) {
      showError(caught);
    } finally {
      setSetupBusy(false);
    }
  }

  async function saveCodebaseMapEnabled(enabled: boolean): Promise<void> {
    if (setupBusy) return;
    setSetupBusy(true);
    try {
      setSnapshot(await window.browserAgent.savePreferences({ codebaseMapEnabled: enabled }));
      showNotice(`Codebase mapping ${enabled ? "enabled" : "disabled"}.`);
    } catch (caught) {
      showError(caught);
    } finally {
      setSetupBusy(false);
    }
  }

  function openSettings(): void {
    setCompactView("chat");
    if (isNarrowWindow()) setHistoryOpen(false);
    setSettingsDestination((current) => ({ tab: "api-key", version: current.version + 1 }));
    setSettingsOpen(true);
    setError(null);
    setNotice("");
    if (snapshot?.preferences.apiKeyConfigured && !availableModels.length) {
      void loadAvailableModels();
    }
  }

  function closeSettings(): void {
    setSettingsOpen(false);
    setApiKey("");
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function chooseProject(): Promise<void> {
    if (activeRunIdRef.current) return;
    await switchProject(() => window.browserAgent.chooseProject());
  }

  async function createProject(name: string): Promise<void> {
    if (activeRunIdRef.current) return;
    await switchProject(() => window.browserAgent.createProject({ name }));
  }

  async function selectRecentProject(recentProject: DesktopRecentProject): Promise<void> {
    if (activeRunIdRef.current) return;
    if (!recentProject.path || recentProject.path === snapshot?.project.path) return;
    await switchProject(() => window.browserAgent.selectProject({
        path: recentProject.path,
      }));
  }

  async function switchProject(select: () => ReturnType<typeof window.browserAgent.chooseProject>): Promise<void> {
    if (activeRunIdRef.current || projectSelectionRef.current || setupBusy) return;
    projectSelectionRef.current = true;
    setSetupBusy(true);
    setPreviewActionError("");
    const previousPath = snapshot?.project.path ?? null;
    try {
      if (snapshot && !["stopped", "failed"].includes(snapshot.project.status)) {
        const stopped = await window.browserAgent.projectAction("stop");
        setSnapshot((current) => current ? { ...current, project: stopped } : current);
      }
      if (activeRunIdRef.current) return;
      const project = await select();
      setSnapshot((current) => current ? { ...current, project } : current);
      // Choosing/creating can be cancelled in the folder dialog, which returns
      // the unchanged current project. Only announce an actual switch.
      if (project.path && project.path !== previousPath) {
        showNotice(`${project.name ?? "Project"} selected.`);
      }
    } catch (caught) {
      showError(caught);
    } finally {
      projectSelectionRef.current = false;
      setSetupBusy(false);
    }
  }

  async function removeRecentProject(project: DesktopRecentProject): Promise<void> {
    setSetupBusy(true);
    try {
      setSnapshot(await window.browserAgent.removeRecentProject(project.path));
      showNotice(`${project.name} removed from project history.`);
    } catch (caught) {
      showError(caught);
    } finally {
      setSetupBusy(false);
    }
  }

  async function toggleProjectPinned(project: DesktopRecentProject): Promise<void> {
    setSetupBusy(true);
    try {
      setSnapshot(await window.browserAgent.setProjectPinned(project.path, !project.pinned));
      showNotice(project.pinned ? `${project.name} unpinned.` : `${project.name} pinned.`);
    } catch (caught) {
      showError(caught);
    } finally {
      setSetupBusy(false);
    }
  }

  async function updateProjectRunCommand(command?: string): Promise<string | null | undefined> {
    if (activeRunIdRef.current || setupBusy) return undefined;
    setSetupBusy(true);
    setPreviewActionError("");
    try {
      const project = await window.browserAgent.selectProject(
        { devCommand: command?.trim() ?? "" },
      );
      setSnapshot((current) => current ? { ...current, project } : current);
      if (command !== undefined) {
        showNotice("Run command saved.");
      } else if (project.devCommand) {
        showNotice(`Run command detected: ${project.devCommand}`);
      } else {
        showNotice("No run command found. Open the app's folder or choose a command in Run settings. HTML pages can use the built-in preview.");
      }
      return project.devCommand;
    } catch (caught) {
      showError(caught);
      return undefined;
    } finally {
      setSetupBusy(false);
    }
  }

  async function controlProject(action: "start" | "stop" | "restart"): Promise<boolean> {
    // Starting/stopping the dev server is independent of agent runs; only a
    // dirty (unsaved) run command must block start/restart.
    if (projectActionRef.current || setupBusy || (action !== "stop" && projectRunCommandDirtyRef.current)) return false;
    projectActionRef.current = true;
    setPreviewActionError("");
    setSetupBusy(true);
    try {
      const project = await window.browserAgent.projectAction(action);
      setSnapshot((current) => current ? { ...current, project } : current);
      showNotice(action === "stop" ? "Project stopped." : project.previewStartup?.phase === "needs-url" ? "Project started. Enter its preview URL to open it." : "");
      return true;
    } catch (caught) {
      setPreviewActionError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      projectActionRef.current = false;
      setSetupBusy(false);
    }
  }

  async function pickBrowserElement(): Promise<void> {
    if (pickingElement) {
      await window.browserAgent.cancelElementPicker().catch(showError);
      return;
    }
    const owner = loadedProjectPathRef.current;
    const chatId = chatHistoryRef.current.activeChatId;
    setPickingElement(true);
    try {
      const element = await window.browserAgent.pickElement();
      if (element && owner === loadedProjectPathRef.current && chatId === chatHistoryRef.current.activeChatId) {
        const context = `Selected page element:\n${JSON.stringify(element, null, 2)}`;
        const current = getComposerDraft(chatHistoryRef.current);
        const next = `${current}${current ? "\n\n" : ""}${context}`;
        if (next.length > MAX_MESSAGE_CHARACTERS) throw new Error("Your draft is too long to add this element. Shorten it and try again.");
        setComposer(next);
        setCompactView("chat");
        window.requestAnimationFrame(() => composerRef.current?.focus());
      }
    } catch (caught) {
      showError(caught);
    } finally {
      setPickingElement(false);
    }
  }

  async function runBrowserAction(action: "back" | "forward" | "reload"): Promise<void> {
    try {
      const browser = await window.browserAgent.browserAction(action);
      setSnapshot((current) => current ? { ...current, browser } : current);
      if (!browser.error) setPreviewActionError("");
    } catch (caught) {
      showError(caught);
    }
  }

  async function editRunCommand(): Promise<void> {
    if (running || setupBusy) return;
    if (snapshot?.project.status === "running" && !await controlProject("stop")) return;
    setSidebarTab("projects"); setHistoryOpen(true);
    window.requestAnimationFrame(() => { const input = document.getElementById("sidebar-project-run-command"); const details = input?.closest("details"); if (details) details.open = true; input?.focus(); });
  }

  async function openPreview(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (running || setupBusy || !snapshot?.project.path || !previewUrl.trim()) return;
    setSetupBusy(true);
    setPreviewActionError("");
    try {
      const browser = await window.browserAgent.navigate(previewUrl.trim());
      setSnapshot((current) => current ? { ...current, browser } : current);
      showNotice("Preview URL saved for this project.");
    } catch (caught) {
      setPreviewActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSetupBusy(false);
    }
  }

  function beginPaneResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    paneResizePointerRef.current = event.pointerId;
    paneResizeValueRef.current = chatPanePercentForWidth(chatPanePercent, panesWidth);
    paneResizeActiveRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingPane(true);
    void window.browserAgent.setBrowserBounds(HIDDEN_BROWSER_BOUNDS).catch(() => undefined);
  }

  function resizePane(event: ReactPointerEvent<HTMLDivElement>): void {
    if (paneResizePointerRef.current !== event.pointerId) return;
    const workspace = panesRef.current?.getBoundingClientRect();
    if (!workspace) return;
    const next = chatPanePercentFromPointer(event.clientX, workspace.left, workspace.width);
    paneResizeValueRef.current = next;
    workspaceRef.current?.style.setProperty("--chat-pane-percent", `${next}%`);
  }

  function finishPaneResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (paneResizePointerRef.current !== event.pointerId) return;
    paneResizePointerRef.current = null;
    paneResizeActiveRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setChatPanePercent(paneResizeValueRef.current);
    setResizingPane(false);
  }

  function resizePaneWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>): void {
    let next = chatPanePercentForWidth(chatPanePercent, panesWidth);
    if (event.key === "ArrowLeft") next += 2;
    else if (event.key === "ArrowRight") next -= 2;
    else if (event.key === "Home") next = DEFAULT_CHAT_PANE_PERCENT;
    else return;
    event.preventDefault();
    setChatPanePercent(chatPanePercentForWidth(next, panesWidth));
  }

  const visibleChatPercent = chatPanePercentForWidth(chatPanePercent, panesWidth);
  const workspaceStyle = {
    "--chat-pane-percent": `${resizingPane ? paneResizeValueRef.current : visibleChatPercent}%`,
  } as CSSProperties;

  return (
    <main ref={workspaceRef} className={`desktop-workspace ${historyOpen ? "history-open" : "history-collapsed"} ${overlaySidebar ? "sidebar-overlay" : ""} ${compactWorkspace ? "compact-workspace" : ""} ${resizingPane ? "pane-resizing" : ""}`} style={workspaceStyle}>
        <aside id="conversation-history" className="history-sidebar workspace-sidebar" aria-label="Workspace sidebar">
          <div className="activity-rail">
            <div className="sidebar-actions">
              <button ref={sidebarToggleRef} className="sidebar-icon-button" type="button" onClick={() => setHistoryOpen((open) => !open)} aria-controls="sidebar-panel" aria-expanded={historyOpen} aria-label={historyOpen ? "Collapse sidebar" : "Expand sidebar"} title={historyOpen ? "Collapse sidebar" : "Expand sidebar"}><UiIcon name="menu" /></button>
            </div>
          </div>

          {historyOpen && <div id="sidebar-panel" className="sidebar-panel">
            <div className="span-wordmark"><strong>Span</strong><span>A workspace for your next idea.</span></div>
            <nav className="labeled-navigation" aria-label="Main navigation">
              {(["projects", "chats", "files"] as const).map((tab) => <button key={tab} type="button" className={!settingsOpen && sidebarTab === tab ? "active" : ""} aria-current={!settingsOpen && sidebarTab === tab ? "page" : undefined} onClick={() => { setSettingsOpen(false); setSidebarTab(tab); setHistoryOpen(true); }}><UiIcon name={tab} /><span>{tab === "files" ? "Files" : tab.charAt(0).toUpperCase() + tab.slice(1)}</span></button>)}
              <button type="button" className={settingsOpen ? "active" : ""} aria-current={settingsOpen ? "page" : undefined} aria-controls="settings-panel" onClick={openSettings}><UiIcon name="settings" /><span>Settings</span></button>
            </nav>
            {sidebarTab === "chats" ? <nav id="conversation-history-list" className="conversation-history" aria-label="Saved conversations">
              <header className="sidebar-panel-header"><div><span>{snapshot?.project.name ?? "No project"}</span><strong>Chats</strong></div><button className="new-chat-button sidebar-new-chat" type="button" onClick={startNewChat} disabled={running || !snapshot?.project.path} aria-label="New chat" title={snapshot?.project.path ? "New chat" : "Choose a project first"}><span aria-hidden="true">＋</span></button></header>
              <label className="project-search"><span className="sr-only">Search chats and messages</span><input type="search" value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="Search chats and messages…" /></label>
              {chatSearch.trim() && !searchChats(chatHistory, chatSearch).length && <div className="conversation-history-empty"><p>No matching chats.</p><button className="button ghost" type="button" onClick={() => setChatSearch("")}>Clear search</button></div>}
              <ul>
                {searchChats(chatHistory, chatSearch).map((chat) => <li className={chat.id === chatHistory.activeChatId ? "active" : ""} key={chat.id}>
                  <button className="conversation-select" type="button" onClick={() => openSavedChat(chat.id)} disabled={running} aria-current={chat.id === chatHistory.activeChatId ? "page" : undefined} title={chat.title}>
                    <strong>{chat.title}{chat.draft && <span className="chat-draft-label"> · Draft</span>}</strong>
                    <time dateTime={new Date(chat.updatedAt).toISOString()}>{formatChatTimestamp(chat.updatedAt)}</time>
                  </button>
                  <RenameChat title={chat.title} onSave={(title) => setChatHistory((current) => { const next = renameChat(current, chat.id, title); chatHistoryRef.current = next; return next; })} />
                  <button className="conversation-delete" type="button" onClick={() => removeSavedChat(chat.id, chat.title)} disabled={running} aria-label={`Delete ${chat.title}`} title="Delete conversation">×</button>
                </li>)}
              </ul>
              {!snapshot?.project.path && <div className="conversation-history-empty"><p>Choose a project to see its chats.</p><button className="button ghost" type="button" disabled={setupBusy} onClick={() => void chooseProject()}>Open project</button></div>}
              {snapshot?.project.path && !chatHistory.chats.length && <div className="conversation-history-empty"><p>No chats in this project yet.</p><button className="button ghost" type="button" onClick={focusComposer} disabled={!chatReady}>Write a message</button></div>}
            </nav> : sidebarTab === "files" ? <div id="project-directory" className="project-directory-panel"><ProjectDirectory
              key={snapshot?.project.path ?? ""}
              projectName={snapshot?.project.name ?? null}
              directory={projectDirectory}
              loading={projectDirectoryLoading}
              error={projectDirectoryError}
              selectedPath={activeCodePath}
              onOpenFile={(path) => void openProjectFile(path)}
              onRefresh={() => void refreshProjectDirectory()}
              onChooseProject={() => void chooseProject()}
            /></div> : sidebarTab === "projects" ? <div id="project-manager" className="project-directory-panel"><ProjectSidebar
              key={snapshot?.project.path ?? ""}
              project={snapshot?.project}
              recentProjects={snapshot?.recentProjects ?? []}
              busy={setupBusy}
              runActive={running}
              actionError={previewActionError}
              onViewLogs={() => { setProjectLogsOpen(true); setCompactView("preview"); }}
              onChooseProject={() => void chooseProject()}
              onCreateProject={(name) => void createProject(name)}
              onSelectRecentProject={(project) => void selectRecentProject(project)}
              onRemoveRecentProject={(project) => void removeRecentProject(project)}
              onToggleProjectPinned={(project) => void toggleProjectPinned(project)}
              onSaveProjectRunCommand={(command) => void updateProjectRunCommand(command)}
              onAutodetectProjectRunCommand={() => updateProjectRunCommand()}
              onRunCommandDirtyChange={onRunCommandDirtyChange}
              onProjectAction={(action) => void controlProject(action)}
            /></div> : <ModelSidebar
              selectedModel={snapshot?.preferences.selectedModel ?? ""}
              apiKeyConfigured={snapshot?.preferences.apiKeyConfigured ?? false}
              models={availableModels}
              busy={setupBusy}
              modelsBusy={modelsBusy}
              onSelect={(model) => void saveSelectedModel(model)}
              onRefresh={() => void loadAvailableModels(true)}
              onOpenSettings={openSettings}
            />}
          </div>}
        </aside>
      {historyOpen && overlaySidebar && <button className="sidebar-scrim" type="button" onClick={() => setHistoryOpen(false)} aria-label="Close sidebar" />}
      <div className="workspace-content" inert={overlaySidebar && historyOpen}>
        <header className="project-context-header"><div><span className="project-context-label">Workspace</span><strong title={snapshot?.project.path ?? "Open or create a project to begin"}>{snapshot?.project.name ?? "Welcome to Span"}</strong></div><button type="button" className="button ghost" onClick={() => { setSidebarTab("projects"); setHistoryOpen(true); }}><UiIcon name="projects" /><span>Projects</span></button></header>
        {compactWorkspace && !settingsOpen && <nav className="compact-view-switch" aria-label="Workspace panel">
          <button type="button" aria-pressed={compactView === "preview"} aria-controls="workspace-preview" onClick={() => { setCompactView("preview"); setHistoryOpen(false); }}>Preview</button>
          <button type="button" aria-pressed={compactView === "chat"} aria-controls="workspace-chat" onClick={() => { setCompactView("chat"); setHistoryOpen(false); }}>Chat</button>
        </nav>}
        <section ref={panesRef} className={`workspace-panes ${settingsOpen ? "settings-open" : ""}`} aria-label="Project workspace">
      <section id="workspace-preview" className={`browser-pane ${projectLogsOpen ? "logs-open" : ""}`} aria-label="Project preview and code viewer" hidden={settingsOpen || (compactWorkspace && compactView !== "preview")}>
        <header className="workspace-tabbar">
          <div className="workspace-view-tabs" role="tablist" aria-label="Workspace views">
            <button className={activeCodePath === null ? "active" : ""} type="button" role="tab" aria-selected={activeCodePath === null} onClick={() => setActiveCodePath(null)}><span aria-hidden="true">◎</span> Preview</button>
            {codeViews.map((view) => <div className={`code-tab ${activeCodePath === view.path ? "active" : ""}`} role="presentation" key={view.path}>
              <button className="code-tab-select" type="button" role="tab" aria-selected={activeCodePath === view.path} onClick={() => setActiveCodePath(view.path)} title={view.path}><span aria-hidden="true">‹/›</span><span>{fileName(view.path)}</span></button>
              <button className="code-tab-close" type="button" onClick={() => closeProjectFile(view.path)} aria-label={`Close ${fileName(view.path)}`} title={`Close ${fileName(view.path)}`}>×</button>
            </div>)}
          </div>
          <button className="project-logs-toggle" type="button" disabled={!snapshot?.project.path} aria-expanded={projectLogsOpen} aria-controls="project-logs" onClick={() => setProjectLogsOpen((open) => !open)}>Logs</button>
        </header>
        <div className="preview-health"><span role="status">{snapshot?.browser.loading ? "Loading preview…" : showPreviewStatus ? previewStatusLabel(previewStatus) : snapshot?.project.status === "running" ? "Project running" : snapshot?.project.path ? "Project stopped · Start runs the server; refresh reloads the page." : "Choose a project to preview"}</span>{snapshot?.project.path && snapshot.project.status !== "running" && <button className="button ghost compact" type="button" disabled={setupBusy || running || projectRunCommandDirty || snapshot.project.status === "starting"} onClick={() => void controlProject("start")}>Start project</button>}</div>
        <header className="browser-toolbar">
          {activeCodePath === null ? <><div className="browser-navigation" aria-label="Browser navigation">
            <button type="button" onClick={() => void pickBrowserElement()} disabled={!snapshot?.browser.url || snapshot.browser.loading} aria-pressed={pickingElement} aria-label={pickingElement ? "Cancel element selection" : "Select element to add to chat"} title={pickingElement ? "Click an element to add it to chat · Escape to cancel" : "Select element to add to chat"}>{pickingElement ? "×" : "⌖"}</button>
            <button type="button" onClick={() => void runBrowserAction("back")} disabled={!snapshot?.browser.canGoBack} aria-label="Back" title="Back">←</button>
            <button type="button" onClick={() => void runBrowserAction("forward")} disabled={!snapshot?.browser.canGoForward} aria-label="Forward" title="Forward">→</button>
            <button type="button" onClick={() => void runBrowserAction("reload")} disabled={!snapshot?.browser.url} aria-label="Refresh preview" title="Refresh the page (does not start the project)">↻</button>
          </div>
          <form className={`browser-location ${snapshot?.browser.loading ? "loading" : ""}`} onSubmit={(event) => void openPreview(event)}>
            <span aria-hidden="true" />
            <input id="project-preview-url" aria-label="Project preview URL" type="url" value={previewUrl} onChange={(event) => setPreviewUrl(event.target.value)} placeholder="http://localhost:3000" disabled={!snapshot?.project.path || running || setupBusy} spellCheck={false} />
            <button type="submit" disabled={!snapshot?.project.path || running || setupBusy || !previewUrl.trim()}>Open</button>
          </form></> : activeCodeView && <div className="code-location" title={activeCodeView.path}><span aria-hidden="true">‹/›</span>{activeCodeView.path}</div>}
        </header>
        <div className="viewer-stage">
          <div ref={browserViewportRef} className={`browser-viewport ${activeCodePath !== null ? "hidden" : ""}`} aria-hidden={activeCodePath !== null}>
            {showPreviewStatus && previewStatus ? <PreviewStatus state={previewStatus}
              busy={setupBusy || running || projectRunCommandDirty}
              onLogs={() => setProjectLogsOpen(true)}
              retryLabel={snapshot?.project.status === "running" ? previewUrl.trim() ? "Retry preview" : "Set preview URL" : "Start project"}
              onRetry={() => {
                if (snapshot?.project.status !== "running") void controlProject("start");
                else if (previewUrl.trim()) void openPreview();
                else document.getElementById("project-preview-url")?.focus();
              }}
              editCommandLabel={snapshot?.project.status === "running" ? "Stop project and edit command" : "Edit run command"}
              onSetUrl={() => document.getElementById("project-preview-url")?.focus()}
              onEditCommand={() => void editRunCommand()} /> : !snapshot?.browser.url && <div className="browser-empty"><span aria-hidden="true">◎</span><h3>{snapshot?.project.path ? "Preview is not running" : "Your preview appears here"}</h3><p>{snapshot?.project.path ? "Start this project to see your changes here." : "Resume, open, or create a project in the welcome panel to get started."}</p>{snapshot?.project.path && <section className="empty-state-actions"><button className="button primary" type="button" disabled={setupBusy || running || projectRunCommandDirty} onClick={() => {
                if (!snapshot?.project.path) void chooseProject();
                else if (snapshot.project.status === "running") { if (previewUrl.trim()) void openPreview(); else document.getElementById("project-preview-url")?.focus(); }
                else void controlProject("start");
              }}>{!snapshot?.project.path ? "Open project" : snapshot.project.status === "running" ? "Open preview" : "Start project"}</button></section>}</div>}
          </div>
          {activeCodeView && <CodeViewer view={activeCodeView} initialScrollTop={workspaceViewRef.current.fileScroll[activeCodeView.path] ?? 0} onScrollPosition={(position) => {
            workspaceViewRef.current.fileScroll[activeCodeView.path] = position;
            scheduleWorkspaceSave();
          }} />}
        </div>
        {projectLogsOpen && <ProjectLogs key={snapshot?.project.path ?? ""} onClose={() => setProjectLogsOpen(false)} />}
      </section>
      <div
        className="pane-resizer"
        role="separator"
        aria-label="Resize chat and browser panels"
        aria-orientation="vertical"
        aria-valuemin={Math.round(chatPanePercentForWidth(0, panesWidth))}
        aria-valuemax={Math.round(chatPanePercentForWidth(100, panesWidth))}
        aria-valuenow={Math.round(visibleChatPercent)}
        aria-valuetext={`${Math.round(visibleChatPercent)}% chat width`}
        aria-controls="workspace-chat workspace-preview"
        tabIndex={compactWorkspace ? -1 : 0}
        hidden={settingsOpen || compactWorkspace}
        onDoubleClick={() => setChatPanePercent(DEFAULT_CHAT_PANE_PERCENT)}
        onKeyDown={resizePaneWithKeyboard}
        onPointerDown={beginPaneResize}
        onPointerMove={resizePane}
        onPointerUp={finishPaneResize}
        onPointerCancel={finishPaneResize}
        onLostPointerCapture={finishPaneResize}
      />

        <section id="workspace-chat" className="chatbox" aria-label="Chat" hidden={!settingsOpen && compactWorkspace && compactView !== "chat"}>
          <header className="workspace-status" aria-label="Workspace status">
            <button type="button" title={snapshot?.project.path ?? "Choose a project"} onClick={() => { setSidebarTab("projects"); setHistoryOpen(true); }}>{snapshot?.project.name ?? "No project"}</button>
            <span>Server: {snapshot?.project.status ?? "stopped"}</span>
            <span>Chat with Span</span>
            <button className="chat-new-chat" type="button" onClick={startNewChat} disabled={running || !snapshot?.project.path} title={running ? "Wait for the current reply to finish" : snapshot?.project.path ? "Start a new chat" : "Choose a project first"}><UiIcon name="plus" />New chat</button>
          </header>
          {settingsOpen ? <SettingsPanel
            key={settingsDestination.version}
            onProjects={() => { closeSettings(); setSidebarTab("projects"); setHistoryOpen(true); }}
            initialTab={settingsDestination.tab}
            recoveryActions={recoveryActions(error)}
            snapshot={snapshot}
            apiKey={apiKey}
            models={availableModels}
            busy={setupBusy}
            modelsBusy={modelsBusy}
            error={error}
            notice={notice}
            onApiKeyChange={setApiKey}
            onSaveApiKey={() => void saveProvider()}
            onModelChange={(model) => void saveSelectedModel(model)}
            onCodebaseMapChange={(enabled) => void saveCodebaseMapEnabled(enabled)}
            onRepositoryMemoryChange={(enabled) => void saveRepositoryMemoryEnabled(enabled)}
            onRefreshModels={() => void loadAvailableModels(true)}
            onClose={closeSettings}
            onDismissFeedback={dismissFeedback}
          /> : <>
          <div className="chat-scroll-shell">
            <div className="chat-scroll-region" ref={chatScrollRef} onScroll={trackChatScroll} role="log" aria-label="Conversation" aria-live="off" aria-busy={running}>
              <div className="messages">
                {!activeChat && missingSetup === null && <div className="empty-state"><div className="span-welcome-mark" aria-hidden="true"><img src={spanMark} alt="" /></div><h3>Welcome to Span</h3><p>Send a message to start a new chat, or choose a previous conversation.</p><section className="empty-state-actions"><button className="button primary" type="button" onClick={focusComposer}>{composer ? "Continue draft" : "Write a message"}</button>{chatHistory.chats.length > 0 && <button className="button ghost" type="button" onClick={showSavedChats}>Browse chats</button>}</section></div>}
              {activeChat && !messages.length && missingSetup === null && <div className="empty-state"><div className="span-welcome-mark" aria-hidden="true"><img src={spanMark} alt="" /></div><h3>{emptyStatePhrase}</h3><section className="empty-state-actions">{composer ? <button className="button primary" type="button" onClick={focusComposer}>Continue draft</button> : <><button className="button ghost" type="button" onClick={() => useStarterPrompt("Review this project and suggest the most useful improvements.")}>Review this project</button><button className="button ghost" type="button" onClick={() => useStarterPrompt("Help me fix a bug. Here is what happens: ")}>Help me fix a bug</button></>}</section></div>}
              {missingSetup !== null && <><ol className="setup-checklist" aria-label="Setup progress">
                <li>{snapshot?.preferences.apiKeyConfigured ? "Provider saved" : "Provider needed"}</li>
                <li>{snapshot?.preferences.selectedModel ? "Model selected" : "Choose model"}</li>
                <li>{snapshot?.project.path ? "Project open" : "Choose project"}</li>
              </ol><SetupMessage step={missingSetup} apiKey={apiKey} busy={setupBusy} onApiKeyChange={setApiKey} onSaveProvider={() => void saveProvider()} onChooseModel={() => void chooseDefaultModel()} onChooseProject={() => void chooseProject()} onCreateProject={(name) => void createProject(name)}
                recentProject={snapshot?.recentProjects[0]} onResume={() => { const project = snapshot?.recentProjects[0]; if (project) void selectRecentProject(project); }} /></>}
              {messages.map((message) => {
                const live = running && message.role === "assistant" && message.id === assistantId.current;
                return <ChatMessage
                  key={message.id}
                  message={message}
                  live={live}
                  progressLabel={live ? runProgress.label : ""}
                  editDisabled={running || setupBusy || !chatReady}
                  onEditSend={(value) => {
                    if (activeRunIdRef.current || setupBusy || !chatReady) return;
                    const submission = prepareEditedMessage(chatHistoryRef.current, message.id, value);
                    if (submission) void runChatSubmission(submission);
                  }}
                />;
              })}
              {!!tools.length && <div className="tool-list" aria-label="Activity"><h3>Activity</h3>{tools.map((tool) => <div className={`tool-item ${tool.status}`} key={tool.id}><div><span aria-hidden="true">{tool.status === "running" ? "···" : tool.status === "done" ? "✓" : tool.status === "approval" ? "!" : "×"}</span><div><strong>{friendlyTool(tool.name)}</strong><small className="tool-status">{tool.status === "approval" ? "Approval needed" : tool.status === "running" ? "Working" : tool.status === "done" ? "Completed" : "Failed"}</small>{tool.summary && <small>{tool.summary}</small>}</div></div>{tool.status === "approval" && <div className="approval-actions"><button className="button primary compact" onClick={() => void decide(tool, "approve")}>Allow action</button><button className="button ghost compact" onClick={() => void decide(tool, "reject")}>Deny action</button></div>}</div>)}</div>}
              {loadedProjectPathRef.current === snapshot?.project.path && <RunReportPanel
                key={snapshot?.project.path}
                reports={runReports}
                storageWarning={runReportStorageWarning}
                onDelete={(runId) => updateRunReports(loadedProjectPathRef.current, runReportsRef.current.filter((report) => report.runId !== runId))}
                onClear={() => updateRunReports(loadedProjectPathRef.current, [])}
              />}
              </div>
            </div>
            <button className={`scroll-to-latest ${showScrollToLatest ? "is-visible" : "is-hidden"}`} type="button" onClick={scrollChatToLatest} aria-label="Scroll to latest message" aria-hidden={!showScrollToLatest} tabIndex={showScrollToLatest ? 0 : -1}>↓ Latest</button>
          </div>

          <div className="composer-dock">
            <div className={`run-status ${runProgress.phase}`} role="status" aria-live="polite">
              {runProgress.phase === "starting" || runProgress.phase === "thinking" ? (
                <picture className="run-thinking-mark" aria-hidden="true">
                  <source media="(prefers-reduced-motion: reduce)" srcSet={spanThinkingStill} />
                  <img src={spanThinking} width="32" height="32" alt="" />
                </picture>
              ) : <span className="run-status-dot" aria-hidden="true" />}
              <div><strong>{runProgress.label || "Ready when you are"}</strong>{runProgress.phase !== "idle" && <small>{runProgress.phase === "error" ? "Review the error below for ways to continue." : runProgress.phase === "approval" ? "Review the action in Activity above, then allow or deny it." : runProgress.detail}</small>}</div>
            </div>
            {(error || failedRun || notice) && <FeedbackMessage error={error ?? failedRun?.error ?? null} notice={notice} onDismiss={dismissFeedback} variant="chat" actions={recoveryActions(error ?? failedRun?.error ?? null)} />}
            <form className="composer" onSubmit={(event) => void submitChat(event)}>
              <label className="sr-only" htmlFor="chat-composer">Message Span</label>
              <textarea id="chat-composer" ref={composerRef} value={composer} rows={1} maxLength={MAX_MESSAGE_CHARACTERS} onChange={(event) => setComposer(event.target.value)} placeholder={running ? "Draft your next message…" : chatReady ? "Describe what you want to build or change…" : "Finish setup above to start chatting"} disabled={!chatReady} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!running) event.currentTarget.form?.requestSubmit(); } }} />
              <div className="composer-actions"><button type="button" className="composer-model" title="Choose a model" disabled={running || setupBusy || !snapshot?.preferences.apiKeyConfigured} onClick={() => openRecoverySettings("model")}><UiIcon name="models" /><span>{availableModels.find((model) => model.id === snapshot?.preferences.selectedModel)?.name || snapshot?.preferences.selectedModel || "Choose model"}</span><span aria-hidden="true">⌄</span></button>{running ? <button type="button" className="button danger" onClick={() => void stopRun()} disabled={runProgress.phase === "stopping"}>{runProgress.phase === "stopping" ? "Stopping…" : "Stop"}</button> : <button className="button primary" disabled={!composer.trim() || !chatReady}>Send</button>}</div>
            </form>
            <p className="composer-hint">{running ? "Your draft is saved. Send it after this run finishes. Shift+Enter adds a line." : "Enter to send · Shift+Enter for a new line"}</p>
          </div>
          </>}
        </section>
        </section>
      </div>
    </main>
  );
}

const ChatMessage = memo(function ChatMessage(props: {
  readonly message: Message;
  readonly live: boolean;
  readonly progressLabel: string;
  readonly editDisabled: boolean;
  readonly onEditSend: (value: string) => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(props.message.content);
  const content = props.message.content || (props.live ? props.progressLabel : "");
  return (
    <article className={`message ${props.message.role} ${props.live ? "streaming" : ""}`}>
      <span>{props.message.role === "user" ? "You" : "Span"}</span>
      {props.message.role === "assistant" && content ? renderMarkdown(content) : <p>{content}</p>}
      {props.live && props.message.content && <i className="stream-cursor" aria-hidden="true" />}
      {!!props.message.content && <div className="message-actions"><CopyButton text={props.message.content} label={props.message.role === "assistant" ? "Copy response" : "Copy message"} disabled={props.live} />
        {props.message.role === "user" && <button type="button" disabled={props.editDisabled} onClick={() => { setEditedText(props.message.content); setEditing(true); }}>Edit and resend</button>}
      </div>}
      {editing && <form className="message-edit" onSubmit={(event) => { event.preventDefault(); if (!props.editDisabled && editedText.trim()) { props.onEditSend(editedText); setEditing(false); } }}>
        <textarea autoFocus aria-label="Edit message" maxLength={MAX_MESSAGE_CHARACTERS} value={editedText} onChange={(event) => setEditedText(event.target.value)} />
        <p>Sends in a new chat with the preceding messages. Your original chat stays saved.</p>
        <button type="submit" disabled={props.editDisabled || !editedText.trim()}>Send edited message</button><button type="button" onClick={() => setEditing(false)}>Cancel</button>
      </form>}
    </article>
  );
});

interface SetupMessageProps {
  readonly recentProject: DesktopRecentProject | undefined;
  readonly onResume: () => void;
  readonly onCreateProject: (name: string) => void;
  readonly step: "loading" | "provider" | "model" | "project";
  readonly apiKey: string;
  readonly busy: boolean;
  readonly onApiKeyChange: (value: string) => void;
  readonly onSaveProvider: () => void;
  readonly onChooseModel: () => void;
  readonly onChooseProject: () => void;
}

interface SettingsPanelProps {
  readonly onProjects: () => void;
  readonly initialTab: SettingsTab | null;
  readonly recoveryActions: ReactElement | undefined;
  readonly snapshot: DesktopSnapshot | undefined;
  readonly apiKey: string;
  readonly models: readonly OpenRouterModel[];
  readonly busy: boolean;
  readonly modelsBusy: boolean;
  readonly error: AgentErrorInfo | null;
  readonly notice: string;
  readonly onApiKeyChange: (value: string) => void;
  readonly onSaveApiKey: () => void;
  readonly onModelChange: (model: string) => void;
  readonly onCodebaseMapChange: (enabled: boolean) => void;
  readonly onRepositoryMemoryChange: (enabled: boolean) => void;
  readonly onRefreshModels: () => void;
  readonly onClose: () => void;
  readonly onDismissFeedback: () => void;
}

type SettingsTab = "api-key" | "model" | "projects" | "settings";

const SETTINGS_TABS: readonly SettingsTab[] = ["api-key", "model", "projects", "settings"];

interface ModelSidebarProps {
  readonly onOpenSettings: () => void;
  readonly selectedModel: string;
  readonly apiKeyConfigured: boolean;
  readonly models: readonly OpenRouterModel[];
  readonly busy: boolean;
  readonly modelsBusy: boolean;
  readonly onSelect: (model: string) => void;
  readonly onRefresh: () => void;
}

function ModelSidebar(props: ModelSidebarProps): ReactElement {
  const [modelSearch, setModelSearch] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [imagesOnly, setImagesOnly] = useState(false);
  const [favoriteModelIds, setFavoriteModelIds] = useState<string[]>(loadFavoriteModels);
  const favoriteModelSet = useMemo(() => new Set(favoriteModelIds), [favoriteModelIds]);
  const filteredModels = useMemo(() => {
    return filterModels(props.models, modelSearch, freeOnly, imagesOnly);
  }, [modelSearch, props.models, freeOnly, imagesOnly]);
  const starredModels = useMemo(() => filteredModels.filter((model) => favoriteModelSet.has(model.id)), [favoriteModelSet, filteredModels]);
  const unstarredModels = useMemo(() => filteredModels.filter((model) => !favoriteModelSet.has(model.id)), [favoriteModelSet, filteredModels]);
  const selectedModelName = props.models.find((model) => model.id === props.selectedModel)?.name ?? props.selectedModel;

  function toggleFavoriteModel(modelId: string): void {
    setFavoriteModelIds((current) => {
      const next = current.includes(modelId)
        ? current.filter((id) => id !== modelId)
        : [...current, modelId];
      saveFavoriteModels(next);
      return next;
    });
  }

  return <section id="model-sidebar" className="model-sidebar" aria-label="Models">
    <header className="sidebar-panel-header"><div><span>OpenRouter</span><strong>Models</strong></div></header>
    <div className="model-sidebar-content">
      {!props.selectedModel && <ModelSuggestion models={props.models} onSelect={props.onSelect} busy={props.busy} />}
      <div className="settings-label"><div><strong>Active model</strong><small>{selectedModelName || "No model selected for this session."}</small></div><span className={props.selectedModel ? "configured" : "required"}>{props.selectedModel ? "Selected" : "Required"}</span></div>
      <div className="model-search-row">
        <label className="sr-only" htmlFor="sidebar-model-search">Search models</label>
        <input id="sidebar-model-search" className="model-search" type="search" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="Search models…" disabled={!props.apiKeyConfigured} />
        <button className="button ghost" type="button" onClick={props.onRefresh} disabled={!props.apiKeyConfigured || props.modelsBusy}>{props.modelsBusy ? "Loading…" : "Refresh"}</button>
      </div>
      <div className="model-list" role="region" aria-label="Available sidebar models" tabIndex={0}>
        {!props.apiKeyConfigured ? <div className="model-list-empty"><p>Save an API key before choosing a model.</p><button className="button ghost" type="button" onClick={props.onOpenSettings}>Connect OpenRouter</button></div> : props.modelsBusy && !props.models.length ? <p className="model-list-empty">Loading models…</p> : <>
          <ModelListSection title="Starred" models={starredModels} selectedModel={props.selectedModel} favoriteModelSet={favoriteModelSet} disabled={props.busy} emptyMessage="Star models to keep them here." onSelect={props.onSelect} onToggleFavorite={toggleFavoriteModel} />
          <ModelListSection title={modelSearch.trim() ? "Search results" : "All models"} models={unstarredModels} selectedModel={props.selectedModel} favoriteModelSet={favoriteModelSet} disabled={props.busy} emptyMessage={modelSearch.trim() ? "No models match your search." : "No additional models are available."} onSelect={props.onSelect} onToggleFavorite={toggleFavoriteModel} />
        </>}
      </div>
    </div>
  </section>;
}

function SettingsPanel(props: SettingsPanelProps): ReactElement {
  const [replacingKey, setReplacingKey] = useState(false);
  const apiKeyConfigured = props.snapshot?.preferences.apiKeyConfigured ?? false;
  const selectedModel = props.snapshot?.preferences.selectedModel ?? "";
  const [modelSearch, setModelSearch] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [imagesOnly, setImagesOnly] = useState(false);
  const [favoriteModelIds, setFavoriteModelIds] = useState<string[]>(loadFavoriteModels);
  const favoriteModelSet = useMemo(() => new Set(favoriteModelIds), [favoriteModelIds]);
  const filteredModels = useMemo(() => {
    return filterModels(props.models, modelSearch, freeOnly, imagesOnly);
  }, [modelSearch, props.models, freeOnly, imagesOnly]);
  const starredModels = useMemo(() => filteredModels.filter((model) => favoriteModelSet.has(model.id)), [favoriteModelSet, filteredModels]);
  const unstarredModels = useMemo(() => filteredModels.filter((model) => !favoriteModelSet.has(model.id)), [favoriteModelSet, filteredModels]);
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>(() => {
    if (props.initialTab) return props.initialTab;
    if (!apiKeyConfigured) return "api-key";
    if (!selectedModel) return "model";
    return "api-key";
  });

  function handleSettingsTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    const currentTab = event.currentTarget.id.replace("settings-tab-", "") as SettingsTab;
    const currentIndex = SETTINGS_TABS.indexOf(currentTab);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % SETTINGS_TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = SETTINGS_TABS.length - 1;
    else return;
    event.preventDefault();
    const nextTab = SETTINGS_TABS[nextIndex] ?? "api-key";
    setActiveSettingsTab(nextTab);
    window.requestAnimationFrame(() => document.getElementById(`settings-tab-${nextTab}`)?.focus());
  }

  function toggleFavoriteModel(modelId: string): void {
    setFavoriteModelIds((current) => {
      const next = current.includes(modelId)
        ? current.filter((id) => id !== modelId)
        : [...current, modelId];
      saveFavoriteModels(next);
      return next;
    });
  }

  useEffect(() => { document.getElementById(`settings-tab-${props.initialTab || "api-key"}`)?.focus(); }, []);
  return <section id="settings-panel" className="settings-workspace" aria-label="Settings" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); props.onClose(); } }}>
    <header className="settings-topbar">
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        <button id="settings-tab-api-key" type="button" role="tab" aria-selected={activeSettingsTab === "api-key"} aria-controls="settings-panel-api-key" tabIndex={activeSettingsTab === "api-key" ? 0 : -1} className={`settings-tab ${activeSettingsTab === "api-key" ? "active" : ""}`} onClick={() => setActiveSettingsTab("api-key")} onKeyDown={handleSettingsTabKeyDown}><span>Connection</span></button>
        <button id="settings-tab-model" type="button" role="tab" aria-selected={activeSettingsTab === "model"} aria-controls="settings-panel-model" tabIndex={activeSettingsTab === "model" ? 0 : -1} className={`settings-tab ${activeSettingsTab === "model" ? "active" : ""}`} onClick={() => setActiveSettingsTab("model")} onKeyDown={handleSettingsTabKeyDown}><span>Models</span></button>
        <button id="settings-tab-projects" type="button" role="tab" aria-selected={activeSettingsTab === "projects"} aria-controls="settings-panel-projects" tabIndex={activeSettingsTab === "projects" ? 0 : -1} className={`settings-tab ${activeSettingsTab === "projects" ? "active" : ""}`} onClick={() => setActiveSettingsTab("projects")} onKeyDown={handleSettingsTabKeyDown}><span>Projects</span></button>
        <button id="settings-tab-settings" type="button" role="tab" aria-selected={activeSettingsTab === "settings"} aria-controls="settings-panel-settings" tabIndex={activeSettingsTab === "settings" ? 0 : -1} className={`settings-tab ${activeSettingsTab === "settings" ? "active" : ""}`} onClick={() => setActiveSettingsTab("settings")} onKeyDown={handleSettingsTabKeyDown}><span>Preferences</span></button>
      </div>
      <button className="settings-close" type="button" onClick={props.onClose} aria-label="Close settings" title="Close settings">×</button>
    </header>

    <div className={`settings-scroll ${activeSettingsTab === "model" ? "model-tab-active" : ""}`}>
      <div className="settings-panel">
        {(props.error || props.notice) && <FeedbackMessage error={props.error} notice={props.notice} onDismiss={props.onDismissFeedback} variant="settings" actions={props.recoveryActions} />}

        {activeSettingsTab === "api-key" && <div id="settings-panel-api-key" className="settings-group settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-api-key" tabIndex={0}>
        <div className="settings-label"><div><strong>OpenRouter API key</strong><small>{apiKeyConfigured ? "A key is saved securely on this computer. This does not verify the connection." : "Required before models can be loaded."}</small></div><span className={apiKeyConfigured ? "configured" : "required"}>{apiKeyConfigured ? "Saved" : "Required"}</span></div>
        {apiKeyConfigured && !replacingKey ? <button className="button ghost" type="button" onClick={() => setReplacingKey(true)}>Replace saved key</button> : <div className="settings-control-row">
          <label className="sr-only" htmlFor="settings-api-key">OpenRouter API key</label>
          <input id="settings-api-key" className="settings-api-key" type="password" value={props.apiKey} onChange={(event) => props.onApiKeyChange(event.target.value)} placeholder={apiKeyConfigured ? "Enter a new key to replace it" : "Paste your OpenRouter key"} autoComplete="off" />
          <button className="button primary" type="button" onClick={props.onSaveApiKey} disabled={props.busy || !props.apiKey.trim()}>{props.busy ? "Saving…" : "Save API key"}</button>
          {apiKeyConfigured && <button className="button ghost" type="button" onClick={() => { props.onApiKeyChange(""); setReplacingKey(false); }}>Cancel</button>}
        </div>}
        </div>}

        {activeSettingsTab === "model" && <div id="settings-panel-model" className="settings-group settings-tab-panel settings-model-tab" role="tabpanel" aria-labelledby="settings-tab-model" tabIndex={0}>
          {!selectedModel && <ModelSuggestion models={props.models} onSelect={props.onModelChange} busy={props.busy} />}
        <div className="settings-label"><div><strong>Model</strong><small>Search and choose any model that supports browser and project tools.</small></div><span className={selectedModel ? "configured" : "required"}>{selectedModel ? "Selected" : "Required"}</span></div>
        <div className="model-search-row">
          <label className="sr-only" htmlFor="settings-model-search">Search models</label>
          <input id="settings-model-search" className="settings-model-search model-search" type="search" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="Search models…" disabled={!apiKeyConfigured} />
          <button className="button ghost" type="button" onClick={props.onRefreshModels} disabled={!apiKeyConfigured || props.modelsBusy}>{props.modelsBusy ? "Loading…" : "Refresh"}</button>
        </div>
        <div className="model-filters"><label><input type="checkbox" checked={freeOnly} onChange={(event) => setFreeOnly(event.target.checked)} />Free models</label><label><input type="checkbox" checked={imagesOnly} onChange={(event) => setImagesOnly(event.target.checked)} />Image input</label><span role="status">{filteredModels.length} models</span></div>
        <div className="model-list" role="region" aria-label="Available models" tabIndex={0}>
          {!apiKeyConfigured ? <p className="model-list-empty">Save an API key before choosing a model.</p> : props.modelsBusy && !props.models.length ? <p className="model-list-empty">Loading models…</p> : <>
            <ModelListSection title="Starred" models={starredModels} selectedModel={selectedModel} favoriteModelSet={favoriteModelSet} disabled={props.busy} emptyMessage="Star models to keep them here." onSelect={props.onModelChange} onToggleFavorite={toggleFavoriteModel} />
            <ModelListSection title={modelSearch.trim() ? "Search results" : "All models"} models={unstarredModels} selectedModel={selectedModel} favoriteModelSet={favoriteModelSet} disabled={props.busy} emptyMessage={modelSearch.trim() ? "No models match your search." : "No additional models are available."} onSelect={props.onModelChange} onToggleFavorite={toggleFavoriteModel} />
          </>}
        </div>
        </div>}

        {activeSettingsTab === "projects" && <div id="settings-panel-projects" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-projects" tabIndex={0}><h2>Project settings</h2><p>{props.snapshot?.project.name || "No project selected"}</p><p>Manage recent projects, choose a folder, or adjust the current project's run command in Projects.</p><button className="button primary" type="button" onClick={props.onProjects}>Open project controls</button></div>}
        {activeSettingsTab === "settings" && <CodebaseMapSettings
          enabled={props.snapshot?.preferences.codebaseMapEnabled ?? false}
          busy={props.busy}
          onChange={props.onCodebaseMapChange}
          repositoryMemoryEnabled={props.snapshot?.preferences.repositoryMemoryEnabled ?? false}
          onRepositoryMemoryChange={props.onRepositoryMemoryChange}
        />}
      </div>
    </div>
  </section>;
}

interface ModelListSectionProps {
  readonly title: string;
  readonly models: readonly OpenRouterModel[];
  readonly selectedModel: string;
  readonly favoriteModelSet: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly emptyMessage: string;
  readonly onSelect: (model: string) => void;
  readonly onToggleFavorite: (model: string) => void;
}

function ModelListSection(props: ModelListSectionProps): ReactElement {
  return <section className="model-section" aria-label={props.title}>
    <header><h2>{props.title}</h2><span>{props.models.length}</span></header>
    {!props.models.length ? <p className="model-section-empty">{props.emptyMessage}</p> : <ul>
      {props.models.map((model) => {
        const selected = model.id === props.selectedModel;
        const favorite = props.favoriteModelSet.has(model.id);
        return <li className={`model-option ${selected ? "selected" : ""}`} key={model.id}>
          <button className="model-select" type="button" onClick={() => props.onSelect(model.id)} disabled={props.disabled} aria-current={selected ? "true" : undefined}>
            <strong>{model.name || model.id}</strong>
              <small>{model.id}</small>
              <ModelFacts model={model} />
          </button>
          <button className="model-star" type="button" onClick={() => props.onToggleFavorite(model.id)} disabled={props.disabled} aria-label={`${favorite ? "Unstar" : "Star"} ${model.name || model.id}`} aria-pressed={favorite} title={favorite ? "Remove from Starred" : "Add to Starred"}>{favorite ? "★" : "☆"}</button>
        </li>;
      })}
    </ul>}
  </section>;
}

function SetupMessage(props: SetupMessageProps): ReactElement {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  if (props.step === "loading") {
    return <div className="setup-message" role="status"><span className="span-setup-mark" aria-hidden="true"><img src={spanMark} alt="" /></span><div><h1>Opening your conversations…</h1></div></div>;
  }
  if (props.step === "provider") {
    return <div className="setup-message"><span className="span-setup-mark" aria-hidden="true"><img src={spanMark} alt="" /></span><div><h1>Connect your AI provider</h1><p>Chat becomes available after you save an OpenRouter key and choose a model. Your key is encrypted on this computer.</p><div className="setup-action"><label className="sr-only" htmlFor="setup-api-key">OpenRouter API key</label><input id="setup-api-key" type="password" value={props.apiKey} onChange={(event) => props.onApiKeyChange(event.target.value)} placeholder="Paste your OpenRouter key" autoComplete="off" /><button className="button primary" type="button" onClick={props.onSaveProvider} disabled={props.busy || !props.apiKey.trim()}>{props.busy ? "Connecting…" : "Connect"}</button></div></div></div>;
  }
  if (props.step === "model") {
    return <div className="setup-message"><span className="span-setup-mark" aria-hidden="true"><img src={spanMark} alt="" /></span><div><h1>Choose your AI model</h1><p>Choose a model to enable chat. You can change it at any time.</p><button className="button primary" type="button" onClick={props.onChooseModel} disabled={props.busy}>{props.busy ? "Loading…" : "Browse models"}</button></div></div>;
  }
  return <div className="setup-message"><span className="span-setup-mark" aria-hidden="true"><img src={spanMark} alt="" /></span><div><h1>{props.recentProject ? "Pick up where you left off" : "Bring your next idea to life"}</h1><p>{props.recentProject ? `Resume ${props.recentProject.name} with your last chat and open files. Start the project server when you're ready.` : "Open an existing project or create a folder for something new."}</p>
    <div className="setup-project-actions">{props.recentProject && <button className="button primary" type="button" onClick={props.onResume} disabled={props.busy} title={props.recentProject.path}>{props.busy ? "Opening…" : "Resume project"}</button>}
      <button className={`button ${props.recentProject ? "ghost" : "primary"}`} type="button" onClick={props.onChooseProject} disabled={props.busy}>{props.busy ? "Opening…" : props.recentProject ? "Open another project" : "Open project"}</button>
      <button className="button ghost" type="button" onClick={() => setCreating((value) => !value)} disabled={props.busy} aria-expanded={creating}>{creating ? "Cancel creation" : "Create project"}</button>
    </div>{creating && <form className="welcome-create-form" onSubmit={(event) => { event.preventDefault(); if (name.trim() && !props.busy) props.onCreateProject(name.trim()); }}><label htmlFor="welcome-project-name">Project name</label><input id="welcome-project-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="My new project" autoFocus disabled={props.busy} /><button className="button primary" type="submit" disabled={props.busy || !name.trim()}>{props.busy ? "Creating…" : "Choose location and create"}</button></form>}</div></div>;
}

interface FeedbackMessageProps {
  readonly actions?: ReactElement | undefined;
  readonly error: AgentErrorInfo | null;
  readonly notice: string;
  readonly onDismiss: () => void;
  readonly variant: "chat" | "settings";
}

function FeedbackMessage({ error, notice, onDismiss, variant, actions }: FeedbackMessageProps): ReactElement {
  const className = `${variant}-feedback ${error ? "error" : "notice"}`;
  return <div className={className} role={error ? "alert" : "status"}>
    <div className="feedback-main">{error ? error.technicalDetail
      ? <details className="error-details">
          <summary><strong>{error.title}</strong><span>{error.detail}</span><small>Click to view technical details</small></summary>
          <pre>{error.technicalDetail}</pre>
        </details>
      : <span className="feedback-copy"><strong>{error.title}</strong><span>{error.detail}</span></span>
      : <span>{notice}</span>}{actions}</div>
    <button type="button" onClick={onDismiss} aria-label="Dismiss message">×</button>
  </div>;
}

function friendlyTool(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function formatChatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function isNarrowWindow(): boolean {
  return window.innerWidth <= OVERLAY_SIDEBAR_PIXELS;
}

function loadChatPanePercent(): number {
  try {
    const stored = Number(window.localStorage.getItem(CHAT_PANE_STORAGE_KEY));
    return stored ? clampStoredChatPanePercent(stored) : DEFAULT_CHAT_PANE_PERCENT;
  } catch {
    return DEFAULT_CHAT_PANE_PERCENT;
  }
}
