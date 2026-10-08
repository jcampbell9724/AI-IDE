import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { DaemonClient, readableError } from "../lib/api";
import { brokerRequest, executeDaemonBrowserRequest, sendContentCommand } from "../lib/browser";
import {
  clearChatHistory,
  createChatHistory,
  deleteConversation,
  getActiveConversation,
  loadChatHistory,
  saveChatHistory,
  selectConversation,
  startNewConversation,
  updateActiveConversation,
  type ChatHistoryState,
} from "../lib/chat-history";
import { friendlyElementLabel, friendlyProjectStatus, friendlyToolName } from "../lib/presentation";
import { projectDraftSync, projectSettingsForPath } from "../lib/project-draft";
import { deriveReadiness } from "../lib/readiness";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeDaemonUrl,
  saveSettings,
} from "../lib/settings";
import type {
  AgentEvent,
  AgentRunRequest,
  ChatMessage,
  ContentEvent,
  EditDelta,
  ElementContext,
  ExtensionSettings,
  ModelInfo,
  ProjectInfo,
  ProjectLog,
  ToolTimelineItem,
} from "../lib/types";

const TABS = ["Chat", "Project", "Models", "Edit", "Connections", "Settings"] as const;
type TabName = (typeof TABS)[number];

const TAB_DESCRIPTIONS: Record<TabName, string> = {
  Chat: "Chat with the coding agent",
  Project: "Choose a project and manage its server",
  Models: "Choose the active AI model",
  Edit: "Preview page changes",
  Connections: "Check local connections",
  Settings: "Configure security and behavior",
};

const QUICK_PROMPTS = [
  "Inspect this project and explain the page I have open.",
  "Review the selected element and suggest one small improvement.",
  "Find the cause of the visible issue before changing any files.",
];

interface ActiveTabInfo {
  id?: number;
  url?: string;
  title?: string;
  status?: string;
}

interface ConnectionChecks {
  daemon: "unknown" | "online" | "offline";
  content: "unknown" | "ready" | "unavailable";
  debugger: "unknown" | "attached" | "detached";
}

const EMPTY_PROJECT: ProjectInfo = { status: "unknown" };

export function App(): ReactElement {
  const [tab, setTab] = useState<TabName>("Chat");
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [showToken, setShowToken] = useState(false);
  const [connected, setConnected] = useState(false);
  const [accessReady, setAccessReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [project, setProject] = useState<ProjectInfo>(EMPTY_PROJECT);
  const [projectPath, setProjectPath] = useState("");
  const [devCommand, setDevCommand] = useState("");
  const [projectUrl, setProjectUrl] = useState("");
  const [logs, setLogs] = useState<ProjectLog[]>([]);
  const logCursor = useRef(0);
  const [chatHistory, setChatHistory] = useState<ChatHistoryState>(() => createChatHistory());
  const [chatHistoryReady, setChatHistoryReady] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const messages = getActiveConversation(chatHistory).messages;
  const [input, setInput] = useState("");
  const [timeline, setTimeline] = useState<ToolTimelineItem[]>([]);
  const [running, setRunning] = useState(false);
  const [runAnnouncement, setRunAnnouncement] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [resolvingApprovalId, setResolvingApprovalId] = useState("");
  const [selections, setSelections] = useState<ElementContext[]>([]);
  const [pickerActive, setPickerActive] = useState(false);
  const [deltas, setDeltas] = useState<EditDelta[]>([]);
  const [editProperty, setEditProperty] = useState("background-color");
  const [editValue, setEditValue] = useState("#2563eb");
  const [activeTab, setActiveTab] = useState<ActiveTabInfo>({});
  const [checks, setChecks] = useState<ConnectionChecks>({
    daemon: "unknown",
    content: "unknown",
    debugger: "unknown",
  });
  const abortRef = useRef<AbortController | undefined>(undefined);
  const chatHistoryRef = useRef(chatHistory);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const approvalButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusedApprovalId = useRef("");
  const serverProjectRef = useRef<ProjectInfo>(EMPTY_PROJECT);

  const setMessages = useCallback((
    update: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[]),
    pendingAssistantId?: string | null,
  ): void => {
    setChatHistory((current) => {
      const active = getActiveConversation(current);
      const nextMessages = typeof update === "function" ? update(active.messages) : update;
      return updateActiveConversation(
        current,
        nextMessages,
        pendingAssistantId === undefined ? active.pendingAssistantId : pendingAssistantId,
      );
    });
  }, []);

  const client = useMemo(
    () => new DaemonClient(settings.daemonUrl, settings.token),
    [settings.daemonUrl, settings.token],
  );

  useEffect(() => {
    let mounted = true;
    void loadChatHistory().then((history) => {
      if (!mounted) return;
      chatHistoryRef.current = history;
      setChatHistory(history);
      setChatHistoryReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    chatHistoryRef.current = chatHistory;
    if (!chatHistoryReady) return;
    const timer = window.setTimeout(() => {
      void saveChatHistory(chatHistory);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [chatHistory, chatHistoryReady]);

  useEffect(() => {
    const flushHistory = (): void => {
      if (chatHistoryReady) void saveChatHistory(chatHistoryRef.current);
    };
    const flushHiddenHistory = (): void => {
      if (document.visibilityState === "hidden") flushHistory();
    };
    window.addEventListener("pagehide", flushHistory);
    document.addEventListener("visibilitychange", flushHiddenHistory);
    return () => {
      window.removeEventListener("pagehide", flushHistory);
      document.removeEventListener("visibilitychange", flushHiddenHistory);
      flushHistory();
    };
  }, [chatHistoryReady]);

  useEffect(() => setAccessReady(false), [client]);

  const applyProjectUpdate = useCallback((next: ProjectInfo, forceDrafts = false) => {
    const previous = serverProjectRef.current;
    const sync = projectDraftSync(previous, next, forceDrafts);
    serverProjectRef.current = next;
    setProject(next);
    if (sync.path) {
      setProjectPath(next.path ?? next.candidates?.[0]?.path ?? "");
    } else if (!next.path && next.candidates?.[0]) {
      setProjectPath((current) => current || next.candidates?.[0]?.path || "");
    }
    if (sync.command) setDevCommand(next.devCommand ?? "");
    if (sync.url) setProjectUrl(next.url ?? "");
  }, []);

  const changeProjectPath = useCallback((path: string) => {
    setProjectPath(path);
    const settingsForPath = projectSettingsForPath(serverProjectRef.current, path);
    setDevCommand(settingsForPath.devCommand);
    setProjectUrl(settingsForPath.projectUrl);
  }, []);

  useEffect(() => {
    void loadSettings()
      .then((loaded) => {
        setSettings(loaded);
        setSettingsDraft(loaded);
      })
      .catch((caught: unknown) => showErrorMessage(readableError(caught)))
      .finally(() => setSettingsReady(true));
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      await client.health();
      setConnected(true);
      setChecks((current) => ({ ...current, daemon: "online" }));
    } catch {
      setConnected(false);
      setAccessReady(false);
      setChecks((current) => ({ ...current, daemon: "offline" }));
    }
  }, [client]);

  const refreshProject = useCallback(async (quiet = false) => {
    try {
      const next = await client.getProject();
      setAccessReady(true);
      applyProjectUpdate(next);
    } catch (caught) {
      setAccessReady(false);
      if (!quiet) showErrorMessage(readableError(caught));
    }
  }, [applyProjectUpdate, client]);

  const refreshModels = useCallback(async (refresh = false) => {
    setModelsBusy(true);
    try {
      const next = await client.listModels(refresh);
      setAccessReady(true);
      setModels(next);
      const preferred = next.find((model) => model.supportsTools);
      const selected = next.find((model) => model.id === settings.selectedModel);
      if (!preferred) {
        if (settings.selectedModel) await persistSettings({ ...settings, selectedModel: "" });
        showErrorMessage("OpenRouter returned no tool-capable models. Check the API key, then refresh the model list.");
      } else if (!settings.selectedModel || selected?.supportsTools !== true) {
        await persistSettings({ ...settings, selectedModel: preferred.id });
      }
    } catch (caught) {
      showErrorMessage(readableError(caught));
    } finally {
      setModelsBusy(false);
    }
  }, [client, settings]);

  useEffect(() => {
    if (!settingsReady) return;
    void checkHealth();
    const timer = setInterval(() => void checkHealth(), 5_000);
    return () => clearInterval(timer);
  }, [checkHealth, settingsReady]);

  useEffect(() => {
    if (!settingsReady || !connected) return;
    void refreshProject(true);
    const timer = setInterval(() => void refreshProject(true), 3_000);
    return () => clearInterval(timer);
  }, [connected, refreshProject, settingsReady]);

  useEffect(() => {
    if (!settingsReady || !connected) return;
    void refreshModels(false);
  }, [client, connected, settingsReady]);

  useEffect(() => {
    logCursor.current = 0;
    setLogs([]);
  }, [project.path]);

  useEffect(() => {
    if (!connected || !project.path) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const result = await client.projectLogs(logCursor.current);
        if (cancelled || !result.logs.length) return;
        logCursor.current = result.next;
        setLogs((current) => [...current, ...result.logs].slice(-300));
      } catch {
        // Project status polling surfaces daemon availability; log polling stays quiet.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, connected, project.path]);

  useEffect(() => {
    void syncPageContext();
    const listener = (message: unknown, sender: chrome.runtime.MessageSender): void => {
      if (sender.id !== chrome.runtime.id || !sender.tab || !isLocalDevelopmentUrl(sender.tab.url)) return;
      if (!isContentEventMessage(message)) return;
      applyContentEvent(message.event);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    const searched = query
      ? models.filter((model) => [model.id, model.name, model.provider].some((value) => value?.toLowerCase().includes(query)))
      : models;
    const filtered = favoritesOnly
      ? searched.filter((model) => settings.favoriteModels.includes(model.id))
      : searched;
    return [...filtered].sort((left, right) => {
      const favoriteDifference = Number(settings.favoriteModels.includes(right.id)) - Number(settings.favoriteModels.includes(left.id));
      return favoriteDifference || left.id.localeCompare(right.id);
    });
  }, [favoritesOnly, modelSearch, models, settings.favoriteModels]);

  const readiness = useMemo(() => deriveReadiness({
    daemonConnected: connected && accessReady,
    token: settings.token,
    selectedModel: settings.selectedModel,
    projectPath: project.path ?? null,
    activeTabUrl: activeTab.url ?? null,
    contentReady: checks.content === "ready",
  }), [accessReady, activeTab.url, checks.content, connected, project.path, settings.selectedModel, settings.token]);

  const coreBlocker = readiness.steps.find((step) => step.id !== "page" && !step.complete);
  const chatReady = coreBlocker === undefined;
  const visibleModels = showAllModels ? filteredModels : filteredModels.slice(0, 32);
  const projectSelected = Boolean(project.path);
  const processBusy = ["starting", "restarting", "stopping"].includes(project.status);
  const projectRunning = project.status === "running";
  const pendingApprovalId = timeline.find((item) => item.status === "approval")?.id;

  useEffect(() => {
    if (!pendingApprovalId || focusedApprovalId.current === pendingApprovalId) return;
    focusedApprovalId.current = pendingApprovalId;
    requestAnimationFrame(() => approvalButtonRef.current?.focus());
  }, [pendingApprovalId]);

  async function persistSettings(next: ExtensionSettings): Promise<void> {
    try {
      const normalized = { ...next, daemonUrl: normalizeDaemonUrl(next.daemonUrl) };
      await saveSettings(normalized);
      setSettings(normalized);
      setSettingsDraft(normalized);
    } catch (caught) {
      showErrorMessage(readableError(caught));
      throw caught;
    }
  }

  function showErrorMessage(message: string): void {
    setNotice("");
    setError(message);
  }

  function showNoticeMessage(message: string): void {
    setError("");
    setNotice(message);
  }

  async function syncPageContext(): Promise<void> {
    try {
      const tabInfo = await brokerRequest<ActiveTabInfo>("tabs.getActive");
      setActiveTab(tabInfo);
      if (tabInfo.url) setProjectUrl((current) => current || tabInfo.url || "");
      const selected = await sendContentCommand<ElementContext[]>("context.capture");
      const preview = await sendContentCommand<EditDelta[]>("edit.deltas");
      setSelections(selected);
      setDeltas(preview);
      setChecks((current) => ({ ...current, content: "ready" }));
    } catch {
      setChecks((current) => ({ ...current, content: "unavailable" }));
    }
  }

  function applyContentEvent(event: ContentEvent): void {
    if (event.type === "selection.added" && event.element) {
      setSelections((current) => current.some((item) => item.id === event.element?.id) ? current : [...current, event.element as ElementContext]);
    } else if (event.type === "selection.removed" && event.elementId) {
      setSelections((current) => current.filter((item) => item.id !== event.elementId));
    } else if (event.type === "selection.cleared") {
      setSelections([]);
    } else if (event.type === "preview.changed" && event.deltas) {
      setDeltas(event.deltas);
    } else if (event.type === "picker.stopped") {
      setPickerActive(false);
    }
  }

  async function selectProject(): Promise<void> {
    try {
      setError("");
      setNotice("");
      const next = await client.selectProject({
        path: projectPath,
        devCommand: devCommand.trim(),
        ...(projectUrl.trim() ? { url: projectUrl.trim() } : {}),
      });
      applyProjectUpdate(next, true);
      showNoticeMessage("Project selected. You can chat now; starting its server here is optional.");
    } catch (caught) {
      showErrorMessage(readableError(caught));
    }
  }

  async function projectAction(action: "start" | "stop" | "restart"): Promise<void> {
    try {
      setError("");
      setNotice("");
      const next = await client.projectAction(action);
      applyProjectUpdate(next);
      showNoticeMessage(action === "start" ? "Starting the project server…" : action === "restart" ? "Restarting the project server…" : "Project server stopped.");
    } catch (caught) {
      showErrorMessage(readableError(caught));
    }
  }

  async function chooseModel(id: string): Promise<void> {
    const model = models.find((candidate) => candidate.id === id);
    if (model?.supportsTools === false) {
      showErrorMessage("This model does not advertise tool support. Choose a tool-capable model for browser and project work.");
      return;
    }
    await persistSettings({ ...settings, selectedModel: id });
    const name = model?.name ?? id;
    showNoticeMessage(`${name} is now the active model.`);
  }

  async function toggleFavorite(id: string): Promise<void> {
    const favoriteModels = settings.favoriteModels.includes(id)
      ? settings.favoriteModels.filter((candidate) => candidate !== id)
      : [...settings.favoriteModels, id];
    await persistSettings({ ...settings, favoriteModels });
  }

  async function submitChat(event: FormEvent): Promise<void> {
    event.preventDefault();
    const content = input.trim();
    if (!content || running || !chatHistoryReady) return;
    if (coreBlocker) {
      setTab(coreBlocker.targetTab);
      showErrorMessage(coreBlockerMessage(coreBlocker.id));
      return;
    }

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content };
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };
    const requestMessages = [...messages, userMessage];
    setMessages([...requestMessages, assistantMessage], assistantMessage.id);
    setInput("");
    setTimeline([]);

    await runAgent(
      requestMessages,
      assistantMessage.id,
      {
        mode: "chat",
      },
      false,
    );
  }

  async function runAgent(
    runMessages: ChatMessage[],
    assistantMessageId: string | undefined,
    context: Record<string, unknown>,
    applyWorkflow: boolean,
  ): Promise<void> {
    const runId = crypto.randomUUID();
    const controller = new AbortController();
    abortRef.current = controller;
    setActiveRunId(runId);
    setRunning(true);
    setRunAnnouncement("Agent is responding.");
    setError("");
    setNotice("");
    let discardWasInstructed = false;
    let sawAssistantContent = false;
    let terminalError = "";
    const request: AgentRunRequest = {
      runId,
      sessionId: getActiveConversation(chatHistory).sessionId,
      model: settings.selectedModel,
      messages: runMessages.map(({ role, content }) => ({ role, content })),
      context: buildDaemonContext(project, activeTab, selections, deltas, context),
      approvalMode: settings.approvalMode,
    };

    try {
      for await (const event of client.runAgent(request, controller.signal)) {
        if (explicitlyDiscardsPreview(event)) discardWasInstructed = true;
        if (
          (event.type === "assistant.delta" && Boolean(event.delta)) ||
          (event.type === "assistant.message" && Boolean(event.content ?? event.message)) ||
          (event.type === "run.completed" && Boolean(event.content))
        ) {
          sawAssistantContent = true;
        }
        if (event.type === "run.error") terminalError = event.error ?? event.message ?? "The agent run failed.";
        await processAgentEvent(event, assistantMessageId);
      }
      if (assistantMessageId && terminalError) {
        setRunAnnouncement("Agent run failed.");
        replaceEmptyAssistantMessage(assistantMessageId, `I couldn’t complete that request.\n\n${readableError(new Error(terminalError))}`);
      } else if (assistantMessageId && !sawAssistantContent) {
        setRunAnnouncement("The model returned an empty response.");
        replaceEmptyAssistantMessage(
          assistantMessageId,
          "This model returned no answer. Try the request again or choose a different tool-capable model.",
        );
      } else {
        setRunAnnouncement("Agent response complete.");
      }
      if (applyWorkflow) {
        if (discardWasInstructed) {
          const next = await sendContentCommand<EditDelta[]>("edit.discard");
          setDeltas(next);
          showNoticeMessage("Code workflow completed and explicitly discarded the temporary preview.");
        } else {
          showNoticeMessage("Code workflow completed. The temporary preview was kept because no discard instruction was returned.");
        }
      }
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        const message = readableError(caught);
        setRunAnnouncement("Agent run failed.");
        showErrorMessage(message);
        if (assistantMessageId) replaceEmptyAssistantMessage(assistantMessageId, `I couldn’t complete that request.\n\n${message}`);
      }
    } finally {
      abortRef.current = undefined;
      setRunning(false);
      setChatHistory((current) => {
        const active = getActiveConversation(current);
        return updateActiveConversation(current, active.messages, null);
      });
    }
  }

  async function processAgentEvent(event: AgentEvent, assistantMessageId?: string): Promise<void> {
    if (event.runId) setActiveRunId(event.runId);
    if (event.type === "assistant.delta" && event.delta && assistantMessageId) {
      setMessages((current) => current.map((message) => (
        message.id === assistantMessageId ? { ...message, content: message.content + event.delta } : message
      )));
    } else if (event.type === "assistant.message" && (event.content || event.message) && assistantMessageId) {
      setMessages((current) => current.map((message) => (
        message.id === assistantMessageId ? { ...message, content: event.content ?? event.message ?? message.content } : message
      )));
    } else if (event.type === "tool.started") {
      upsertTool({
        id: event.toolCallId ?? event.toolId ?? crypto.randomUUID(),
        name: event.name ?? event.tool ?? "Tool",
        status: "running",
        ...optionalText("summary", event.summary ?? summarizeValue(event.arguments)),
        startedAt: Date.now(),
      });
    } else if (event.type === "tool.finished") {
      finishTool(
        event.toolCallId ?? event.toolId,
        event.error ? "error" : "completed",
        event.summary ?? event.error ?? summarizeValue(event.result),
      );
    } else if (event.type === "approval.required") {
      upsertTool({
        id: event.toolId ?? event.approvalId ?? crypto.randomUUID(),
        name: event.kind ? "Approve " + event.kind : event.tool ?? "Approval required",
        status: "approval",
        ...optionalText("summary", event.summary),
        ...optionalText("approvalId", event.approvalId),
        startedAt: Date.now(),
      });
    } else if (event.type === "approval.resolved") {
      finishTool(event.toolCallId ?? event.toolId ?? event.approvalId, event.decision === "reject" ? "rejected" : "running", event.summary);
    } else if (event.type === "browser.request") {
      const request = event.request;
      if (!request) throw new Error("Daemon sent a browser request without a request body.");
      try {
        const result = await executeDaemonBrowserRequest(request);
        await client.submitBrowserResult(request.id, { result });
      } catch (caught) {
        await client.submitBrowserResult(request.id, { error: readableError(caught) });
      }
    } else if (event.type === "run.error") {
      showErrorMessage(readableError(new Error(event.error ?? event.message ?? "Agent run failed.")));
    } else if (event.type === "run.cancelled") {
      setRunAnnouncement("Agent run stopped.");
      showNoticeMessage("Run stopped.");
      if (assistantMessageId) replaceEmptyAssistantMessage(assistantMessageId, "Stopped before the task completed.");
    } else if (event.type === "run.completed" && event.content && assistantMessageId) {
      setMessages((current) => current.map((message) => (
        message.id === assistantMessageId && !message.content ? { ...message, content: event.content ?? "" } : message
      )));
    }
  }

  function replaceEmptyAssistantMessage(id: string, content: string): void {
    setMessages((current) => current.map((message) => (
      message.id === id && !message.content ? { ...message, content } : message
    )));
  }

  function upsertTool(item: ToolTimelineItem): void {
    setTimeline((current) => {
      const index = current.findIndex((candidate) => candidate.id === item.id);
      if (index < 0) return [...current, item];
      return current.map((candidate) => candidate.id === item.id ? { ...candidate, ...item } : candidate);
    });
  }

  function finishTool(id: string | undefined, status: ToolTimelineItem["status"], summary?: string): void {
    if (!id) return;
    setTimeline((current) => current.map((item) => (
      item.id === id ? { ...item, status, ...(summary ? { summary } : {}), finishedAt: Date.now() } : item
    )));
  }

  async function resolveApproval(item: ToolTimelineItem, decision: "approve" | "reject"): Promise<void> {
    if (!item.approvalId) return;
    try {
      setResolvingApprovalId(item.approvalId);
      await client.resolveApproval(item.approvalId, decision);
      finishTool(item.id, decision === "approve" ? "running" : "rejected", decision === "approve" ? "Approved" : "Rejected");
    } catch (caught) {
      showErrorMessage(readableError(caught));
    } finally {
      setResolvingApprovalId("");
    }
  }

  async function stopRun(): Promise<void> {
    const runId = activeRunId;
    abortRef.current?.abort();
    if (runId) {
      try {
        await client.cancelRun(runId);
      } catch (caught) {
        showErrorMessage(readableError(caught));
      }
    }
    setRunning(false);
    setRunAnnouncement("Agent run stopped.");
  }

  async function removeSelection(id: string): Promise<void> {
    try {
      const next = await sendContentCommand<ElementContext[]>("selection.remove", { id });
      setSelections(next);
    } catch (caught) {
      showErrorMessage(readableError(caught));
    }
  }

  async function clearSelections(): Promise<void> {
    const next = await pageCommand<ElementContext[]>("picker.clear");
    if (next) setSelections(next);
  }

  async function togglePicker(): Promise<void> {
    if (pickerActive) {
      await pageCommand("picker.stop");
      setPickerActive(false);
      return;
    }
    const result = await pageCommand<{ active: true }>("picker.start", { multiple: true });
    if (result?.active) {
      setPickerActive(true);
      showNoticeMessage("Picker active. Click an element on the page; hold Shift to keep selecting. Press Escape to cancel.");
    }
  }

  function startNewTask(): void {
    if (running || !chatHistoryReady) return;
    setChatHistory((current) => {
      if (!getActiveConversation(current).messages.length) return current;
      return startNewConversation(current);
    });
    setHistoryOpen(false);
    resetConversationView();
    setNotice("New task started. Selected page elements are still attached.");
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function openSavedConversation(conversationId: string): void {
    if (running) return;
    if (conversationId === chatHistory.activeConversationId) {
      setHistoryOpen(false);
      return;
    }
    setChatHistory((current) => selectConversation(current, conversationId));
    setHistoryOpen(false);
    resetConversationView();
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function removeSavedConversation(conversationId: string, title: string): void {
    if (running || !window.confirm(`Delete “${title}”? This cannot be undone.`)) return;
    const removedActiveConversation = conversationId === chatHistory.activeConversationId;
    setChatHistory((current) => deleteConversation(current, conversationId));
    if (removedActiveConversation) resetConversationView();
  }

  function removeAllSavedConversations(): void {
    if (running || !window.confirm("Delete every saved conversation? This cannot be undone.")) return;
    void clearChatHistory();
    setChatHistory(createChatHistory());
    setHistoryOpen(false);
    resetConversationView();
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function resetConversationView(): void {
    setInput("");
    setTimeline([]);
    setError("");
    setNotice("");
    setRunAnnouncement("");
    setActiveRunId("");
    setResolvingApprovalId("");
  }

  function useQuickPrompt(prompt: string): void {
    setInput(prompt);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function openProjectPage(): Promise<void> {
    const url = projectUrl.trim() || project.url;
    if (!url) {
      showErrorMessage("Add the project’s local browser URL first.");
      return;
    }
    try {
      await brokerRequest("tabs.navigate", { url });
      setTab("Chat");
      showNoticeMessage("Opened the project page. Refresh once if the page picker was just installed.");
      setTimeout(() => void syncPageContext(), 1000);
    } catch (caught) {
      showErrorMessage(readableError(caught));
    }
  }

  async function pageCommand<T>(command: string, params?: Record<string, unknown>): Promise<T | undefined> {
    try {
      const result = await sendContentCommand<T>(command, params);
      setChecks((current) => ({ ...current, content: "ready" }));
      return result;
    } catch (caught) {
      setChecks((current) => ({ ...current, content: "unavailable" }));
      showErrorMessage(readableError(caught));
      return undefined;
    }
  }

  async function applyPreview(): Promise<void> {
    const next = await pageCommand<EditDelta[]>("edit.apply", {
      selectors: selections.map((selection) => selection.selector),
      property: editProperty,
      value: editValue,
    });
    if (next) setDeltas(next);
  }

  async function editHistory(command: "edit.undo" | "edit.redo" | "edit.discard"): Promise<void> {
    const next = await pageCommand<EditDelta[]>(command);
    if (next) setDeltas(next);
  }

  async function applyToCode(): Promise<void> {
    if (running || !deltas.length) return;
    if (!settings.selectedModel) {
      showErrorMessage("Select a model before applying edits to code.");
      setTab("Models");
      return;
    }
    const workflowMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: "Apply the current reversible visual preview deltas to the project source code.",
    };
    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
    };
    const requestMessages = [...messages, workflowMessage];
    setMessages([...requestMessages, assistantMessage], assistantMessage.id);
    setTimeline([]);
    await runAgent(
      requestMessages,
      assistantMessage.id,
      { mode: "apply-to-code", instruction: "Persist the supplied visualChanges in project source files." },
      true,
    );
  }

  async function refreshConnections(): Promise<void> {
    await checkHealth();
    try {
      const tabInfo = await brokerRequest<ActiveTabInfo>("tabs.getActive");
      setActiveTab(tabInfo);
      await sendContentCommand("context.capture");
      setChecks((current) => ({ ...current, content: "ready" }));
    } catch {
      setChecks((current) => ({ ...current, content: "unavailable" }));
    }
    try {
      const status = await brokerRequest<{ attached: boolean }>("cdp.status");
      setChecks((current) => ({ ...current, debugger: status.attached ? "attached" : "detached" }));
    } catch {
      setChecks((current) => ({ ...current, debugger: "unknown" }));
    }
  }

  async function setDebugger(attached: boolean): Promise<void> {
    if (attached && !settings.cdpEnabled) {
      showErrorMessage("Enable the optional CDP adapter in Settings before attaching it.");
      return;
    }
    try {
      await brokerRequest(attached ? "cdp.attach" : "cdp.detach");
      setChecks((current) => ({ ...current, debugger: attached ? "attached" : "detached" }));
    } catch (caught) {
      showErrorMessage(readableError(caught));
    }
  }

  async function saveConfiguration(): Promise<void> {
    try {
      await persistSettings(settingsDraft);
      showNoticeMessage("Settings saved in extension-only local storage.");
      await checkHealth();
    } catch {
      // persistSettings already surfaced the validation error.
    }
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = TABS[nextIndex];
    if (!nextTab) return;
    setTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`tab-${nextTab.toLowerCase()}`)?.focus());
  }

  const selectedModelName = models.find((model) => model.id === settings.selectedModel)?.name ?? settings.selectedModel;
  const connectionTone = !connected ? "offline" : readiness.ready ? "ready" : "setup";
  const connectionLabel = !connected
    ? "Helper offline"
    : !accessReady && settings.token
      ? "Check pairing token"
      : readiness.ready ? "Ready" : readiness.summary;
  const pageLabel = checks.content === "ready" ? "Page connected" : "Page unavailable";

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="topbar">
          <div className="brand-row">
            <div className="brand-mark" aria-hidden="true">A</div>
            <div className="brand-copy"><h1>Browser Agent</h1><p>Your local development companion</p></div>
          </div>
          <span className={`readiness-badge ${connectionTone}`} role="status" aria-live="polite">
            <span aria-hidden="true" />{connectionLabel}
          </span>
        </div>

        <div className="context-strip" aria-label="Current agent context">
          <button
            className="context-button"
            onClick={() => setTab("Project")}
            aria-label={`Project: ${project.name || basename(project.path) || "not selected"}. ${friendlyProjectStatus(project)}`}
          >
            <span>Project</span><strong>{project.name || basename(project.path) || "Choose project"}</strong><small>{friendlyProjectStatus(project)}</small>
          </button>
          <button
            className="context-button"
            onClick={() => setTab("Models")}
            aria-label={`Model: ${selectedModelName || "not selected"}`}
          >
            <span>Model</span><strong>{selectedModelName || "Choose model"}</strong><small>{settings.selectedModel ? "Tool-capable" : "Required"}</small>
          </button>
          <button className="context-button" onClick={() => setTab("Connections")} aria-label={`${pageLabel}: ${activeTab.title ?? activeTab.url ?? "no active web page"}`}>
            <span>Current page</span><strong>{activeTab.title ?? "No page connected"}</strong><small>{pageLabel}</small>
          </button>
        </div>

        <nav className="tabs" role="tablist" aria-label="Agent sections">
          {TABS.map((name, index) => (
            <button
              key={name}
              id={`tab-${name.toLowerCase()}`}
              className={`nav-tab ${tab === name ? "active" : ""}`}
              role="tab"
              aria-selected={tab === name}
              aria-controls={`panel-${name.toLowerCase()}`}
              tabIndex={tab === name ? 0 : -1}
              title={TAB_DESCRIPTIONS[name]}
              onClick={() => setTab(name)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {name}{name === "Edit" && deltas.length > 0 && <span className="tab-count">{deltas.length}</span>}
            </button>
          ))}
        </nav>
      </header>

      {error && <div className="banner error" role="alert" aria-atomic="true"><span>{error}</span><button className="text-button" onClick={() => setError("")} aria-label="Dismiss error">Dismiss</button></div>}
      {notice && <div className="banner notice" role="status" aria-live="polite" aria-atomic="true"><span>{notice}</span><button className="text-button" onClick={() => setNotice("")} aria-label="Dismiss notice">Dismiss</button></div>}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{runAnnouncement}</div>

      <section
        className="panel-body"
        id={`panel-${tab.toLowerCase()}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab.toLowerCase()}`}
        tabIndex={-1}
      >
        {tab === "Chat" && (
          <div className="chat-layout">
            <div className="chat-toolbar">
              <div><h2>Chat</h2><p>{chatReady ? "Describe the outcome; the agent will inspect before editing." : "Finish setup to start a coding task."}</p></div>
              <div className="chat-toolbar-actions">
                <button className={`button secondary compact ${historyOpen ? "active" : ""}`} onClick={() => setHistoryOpen((open) => !open)} disabled={!chatHistoryReady} aria-expanded={historyOpen} aria-controls="extension-chat-history">History <span>{chatHistory.conversations.length}</span></button>
                <button className="button secondary compact" onClick={startNewTask} disabled={running || !chatHistoryReady}>New task</button>
              </div>
            </div>

            {historyOpen && <section id="extension-chat-history" className="chat-history-panel" aria-label="Saved conversations">
              <header><div><strong>Recent conversations</strong><span>Stored in this browser</span></div><button className="text-button danger-text" type="button" onClick={removeAllSavedConversations} disabled={running}>Clear all</button></header>
              <div className="chat-history-list">
                {chatHistory.conversations.map((conversation) => <div className={`chat-history-item ${conversation.id === chatHistory.activeConversationId ? "active" : ""}`} key={conversation.id}>
                  <button className="chat-history-select" type="button" onClick={() => openSavedConversation(conversation.id)} disabled={running} aria-current={conversation.id === chatHistory.activeConversationId ? "true" : undefined}>
                    <strong>{conversation.title}</strong>
                    <span><time dateTime={new Date(conversation.updatedAt).toISOString()}>{formatConversationTimestamp(conversation.updatedAt)}</time> · {conversation.messages.length} {conversation.messages.length === 1 ? "message" : "messages"}</span>
                  </button>
                  <button className="chat-history-delete" type="button" onClick={() => removeSavedConversation(conversation.id, conversation.title)} disabled={running} aria-label={`Delete ${conversation.title}`} title="Delete conversation">×</button>
                </div>)}
              </div>
            </section>}

            {!readiness.ready && <ReadinessCard readiness={readiness} onNavigate={setTab} />}

            <div className="messages" role="log" aria-label="Conversation" aria-live="off" aria-busy={running}>
              {!messages.length && chatReady && (
                <div className="empty-state">
                  <div className="empty-icon" aria-hidden="true">✦</div>
                  <h2>What should we improve?</h2>
                  <p>Ask about the project, or attach something from the page and describe the result you want.</p>
                  <div className="quick-prompts" aria-label="Example prompts">
                    {QUICK_PROMPTS.map((prompt) => <button key={prompt} className="prompt-button" onClick={() => useQuickPrompt(prompt)}>{prompt}</button>)}
                  </div>
                </div>
              )}
              {messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <span>{message.role === "user" ? "You" : "Agent"}</span>
                  <p>{message.content || (running ? "Thinking…" : "Waiting for a response…")}</p>
                </article>
              ))}
            </div>

            {!!timeline.length && (
              <section className="timeline" aria-labelledby="activity-title">
                <div className="timeline-heading"><h3 id="activity-title">Agent activity</h3><span>{timeline.filter((item) => item.status === "completed").length}/{timeline.length} done</span></div>
                <ul>
                  {timeline.map((item) => {
                    const resolving = item.approvalId === resolvingApprovalId;
                    return <li key={item.id} className={`tool-item ${item.status}`} role={item.status === "approval" ? "alert" : undefined} aria-busy={resolving}>
                      <span className="tool-dot" aria-hidden="true" />
                      <div><strong>{friendlyToolName(item.name)}</strong>{item.summary && <p>{item.summary}</p>}</div>
                      <small>{toolStatusLabel(item.status)}</small>
                      {item.status === "approval" && (
                        <div className="approval-actions">
                          <p>This action changes your project or browser and needs permission.</p>
                          <div className="button-row">
                            <button ref={item.id === pendingApprovalId ? approvalButtonRef : undefined} className="button primary" disabled={resolving} onClick={() => void resolveApproval(item, "approve")} aria-label={`Approve ${friendlyToolName(item.name)}`}>{resolving ? "Working…" : "Approve"}</button>
                            <button className="button danger" disabled={resolving} onClick={() => void resolveApproval(item, "reject")} aria-label={`Reject ${friendlyToolName(item.name)}`}>Reject</button>
                          </div>
                        </div>
                      )}
                    </li>;
                  })}
                </ul>
              </section>
            )}

            {!!deltas.length && (
              <div className="preview-banner" role="status">
                <div><strong>{deltas.length} preview {deltas.length === 1 ? "change" : "changes"}</strong><span>Visible in the page, not saved to source yet.</span></div>
                <div className="button-row"><button className="button secondary compact" onClick={() => setTab("Edit")}>Review</button><button className="button ghost compact" onClick={() => void editHistory("edit.discard")}>Discard</button></div>
              </div>
            )}

            <form className={`composer ${!chatReady ? "blocked" : ""}`} onSubmit={(event) => void submitChat(event)}>
              {!!selections.length && (
                <div className="selection-context">
                  <div className="selection-summary"><strong>{selections.length} page {selections.length === 1 ? "element" : "elements"} attached</strong><button type="button" className="text-button" onClick={() => void clearSelections()}>Clear all</button></div>
                  <div className="chips">
                    {selections.map((element) => {
                      const label = friendlyElementLabel(element);
                      return <span className="chip" key={element.id} title={element.selector}>
                        <span aria-hidden="true">⌖</span>{shorten(label, 42)}
                        <button type="button" aria-label={`Remove ${label}`} onClick={() => void removeSelection(element.id)}>×</button>
                      </span>;
                    })}
                  </div>
                </div>
              )}
              <label className="sr-only" htmlFor="chat-message">Message the coding agent</label>
              <textarea
                ref={composerRef}
                id="chat-message"
                aria-describedby="composer-hint"
                placeholder={!chatHistoryReady ? "Loading conversations…" : chatReady ? "Describe what you want to build or fix…" : "Complete setup to start chatting"}
                value={input}
                disabled={!chatReady || !chatHistoryReady}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="composer-meta">
                <button type="button" className={`picker-button ${pickerActive ? "active" : ""}`} disabled={checks.content !== "ready"} onClick={() => void togglePicker()} aria-pressed={pickerActive} aria-label={pickerActive ? "Stop picking page elements" : "Pick page elements"}>⌖ <span>{pickerActive ? "Stop picking" : "Pick from page"}</span></button>
                <label className="model-shortcut"><span className="sr-only">Active model</span><select value={settings.selectedModel} onChange={(event) => void chooseModel(event.target.value)} disabled={!models.length || running}><option value="">Choose model</option>{models.filter((model) => model.supportsTools !== false).map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}</select></label>
              </div>
              <div className="composer-actions">
                <span id="composer-hint">{chatReady ? `${approvalModeLabel(settings.approvalMode)} · Enter to send` : coreBlocker?.actionLabel}</span>
                {running
                  ? <button type="button" className="button danger" onClick={() => void stopRun()}>Stop</button>
                  : coreBlocker
                    ? <button type="button" className="button primary" onClick={() => setTab(coreBlocker.targetTab)}>{coreBlocker.actionLabel}</button>
                    : <button type="submit" className="button primary" disabled={!input.trim() || !chatHistoryReady}>Send</button>}
              </div>
            </form>
          </div>
        )}

        {tab === "Project" && (
          <div className="section-stack">
            <div className="section-heading"><div><h2>Project</h2><p>Choose the folder the agent may read and change.</p></div><button className="button secondary compact" onClick={() => void refreshProject(false)}>Refresh</button></div>

            {projectSelected && (
              <div className="project-summary">
                <div><span className={`runtime-dot ${project.status}`} aria-hidden="true" /><div><strong>{project.name || basename(project.path)}</strong><p>{friendlyProjectStatus(project)}</p></div></div>
                <code title={project.path}>{project.path}</code>
              </div>
            )}

            <div className="form-card">
              <label htmlFor="project-path">Project folder</label>
              <input id="project-path" value={projectPath} onChange={(event) => changeProjectPath(event.target.value)} placeholder="C:\\path\\to\\project" aria-describedby="project-path-help" />
              <p className="field-help" id="project-path-help">This becomes the workspace boundary for files and commands.</p>
              {project.candidates && project.candidates.length > 0 && <label htmlFor="detected-project">Detected project<select id="detected-project" value={projectPath} onChange={(event) => changeProjectPath(event.target.value)}><option value="">Choose a project</option>{project.candidates.map((candidate) => <option key={candidate.path} value={candidate.path}>{candidate.name ?? candidate.path}</option>)}</select></label>}
              <details className="disclosure">
                <summary>Advanced project settings</summary>
                <div className="disclosure-content">
                  <label htmlFor="dev-command">Development command (auto-detected)<input id="dev-command" value={devCommand} onChange={(event) => setDevCommand(event.target.value)} placeholder="Optional command override" /></label>
                  <label htmlFor="project-url">Local browser URL<input id="project-url" value={projectUrl} onChange={(event) => setProjectUrl(event.target.value)} placeholder="http://localhost:5173" /></label>
                </div>
              </details>
              <button className="button primary full" onClick={() => void selectProject()} disabled={!projectPath.trim()}>{projectSelected ? "Update project" : "Use this project"}</button>
            </div>

            {projectSelected && (
              <>
                {project.status === "stopped" && <div className="info-callout"><strong>Already running it in another terminal?</strong><p>That’s fine. The agent can still work with the selected folder and open page. Only press Start if you want this panel to manage the server.</p></div>}
                <div className="runtime-card">
                  <div><span className={`runtime-dot ${project.status}`} aria-hidden="true" /><div><strong>{friendlyProjectStatus(project)}</strong><small>{project.pid ? `Process ${project.pid}` : "No managed process"}</small></div></div>
                  <div className="button-row">
                    <button className="button success" onClick={() => void projectAction("start")} disabled={projectRunning || processBusy}>Start</button>
                    <button className="button secondary" onClick={() => void projectAction("restart")} disabled={!projectRunning || processBusy}>Restart</button>
                    <button className="button danger" onClick={() => void projectAction("stop")} disabled={!projectRunning || processBusy}>Stop</button>
                  </div>
                  {project.error && <p className="runtime-error">{project.error}</p>}
                </div>
                {(projectUrl || project.url) && <button className="button secondary full" onClick={() => void openProjectPage()}>Open project page</button>}
                <details className="logs disclosure" open={project.status === "failed"}>
                  <summary>Development logs {logs.length ? `(${logs.length})` : ""}</summary>
                  <div className="logs-header"><span>Latest output</span><button className="text-button" onClick={() => setLogs([])}>Clear view</button></div>
                  <pre tabIndex={0} role="log" aria-live="off" aria-label="Development logs">{logs.length ? logs.map((line) => `[${line.seq}] ${line.text}`).join("\n") : "No managed server output yet."}</pre>
                </details>
              </>
            )}
          </div>
        )}

        {tab === "Models" && (
          <div className="section-stack">
            <div className="section-heading"><div><h2>Models</h2><p>Choose which OpenRouter model handles the next task.</p></div><button className="button secondary compact" onClick={() => void refreshModels(true)} disabled={modelsBusy}>{modelsBusy ? "Refreshing…" : "Refresh"}</button></div>
            {settings.selectedModel && <div className="current-model"><span>Active model</span><strong>{selectedModelName}</strong><small>Used for your next message</small></div>}
            <label className="sr-only" htmlFor="model-search">Search models</label>
            <input id="model-search" className="search" type="search" value={modelSearch} onChange={(event) => { setModelSearch(event.target.value); setShowAllModels(false); }} placeholder="Search model or provider" />
            <div className="filter-row">
              <button className={`filter-button ${!favoritesOnly ? "active" : ""}`} aria-pressed={!favoritesOnly} onClick={() => setFavoritesOnly(false)}>All</button>
              <button className={`filter-button ${favoritesOnly ? "active" : ""}`} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(true)}>★ Favorites</button>
              <span role="status" aria-live="polite">{filteredModels.length} models</span>
            </div>
            <ul className="model-list">
              {visibleModels.map((model) => {
                const selected = settings.selectedModel === model.id;
                const favorite = settings.favoriteModels.includes(model.id);
                return <li className={`model-card ${selected ? "selected" : ""}`} key={model.id}>
                  <button className="favorite" aria-label={favorite ? `Remove ${model.name ?? model.id} from favorites` : `Add ${model.name ?? model.id} to favorites`} aria-pressed={favorite} onClick={() => void toggleFavorite(model.id)}>{favorite ? "★" : "☆"}</button>
                  <button className="model-select" aria-pressed={selected} disabled={model.supportsTools === false} onClick={() => void chooseModel(model.id)}><strong>{model.name ?? model.id}</strong><span>{model.provider ?? model.id.split("/")[0]}{model.contextLength ? ` · ${formatNumber(model.contextLength)} context` : ""}{model.supportsTools === false ? " · No tool support" : " · Tools"}</span>{model.description && <p>{shorten(model.description, 140)}</p>}</button>
                  {selected && <span className="selected-badge">Active</span>}
                </li>;
              })}
            </ul>
            {!modelsBusy && !filteredModels.length && <div className="empty-inline">No models match this search.</div>}
            {!showAllModels && filteredModels.length > visibleModels.length && <button className="button secondary full" onClick={() => setShowAllModels(true)}>Show {filteredModels.length - visibleModels.length} more</button>}
          </div>
        )}

        {tab === "Edit" && (
          <div className="section-stack">
            <div className="section-heading"><div><h2>Preview page changes</h2><p>Experiment in the browser before changing source files.</p></div><span className="count-badge">{deltas.length} pending</span></div>
            {checks.content !== "ready" ? (
              <div className="empty-action"><h3>Connect a local page first</h3><p>Open your localhost app, refresh it after loading the extension, then check the page connection.</p><button className="button primary" onClick={() => setTab("Connections")}>Check connection</button></div>
            ) : (
              <>
                <div className="edit-stage"><span>1</span><div><strong>Select on page</strong><p>Click an element; hold Shift to keep selecting.</p></div><button className={`button secondary ${pickerActive ? "active" : ""}`} onClick={() => void togglePicker()} aria-pressed={pickerActive}>{pickerActive ? "Stop picking" : "Pick elements"}</button></div>
                <div className="selection-list">
                  {selections.map((element) => <div className="selection-row" key={element.id}><div><strong>{friendlyElementLabel(element)}</strong><code title={element.selector}>{shorten(element.selector, 64)}</code></div><button className="button ghost compact" onClick={() => void removeSelection(element.id)}>Remove</button></div>)}
                  {!selections.length && <div className="empty-inline">Nothing selected yet.</div>}
                </div>
                <div className="edit-stage"><span>2</span><div><strong>Preview a style</strong><p>The temporary layer can be undone or discarded.</p></div></div>
                <div className="edit-grid">
                  <label htmlFor="edit-property">Property<select id="edit-property" value={editProperty} onChange={(event) => setEditProperty(event.target.value)}>{["background-color", "color", "font-size", "font-weight", "padding", "margin", "gap", "border-radius", "border-width", "box-shadow", "opacity", "width", "height", "display", "visibility", "transform"].map((property) => <option key={property}>{property}</option>)}</select></label>
                  <label htmlFor="edit-value">New value<input id="edit-value" value={editValue} onChange={(event) => setEditValue(event.target.value)} placeholder="#ec4899 or 24px" /></label>
                </div>
                <div className="button-row"><button className="button primary" onClick={() => void applyPreview()} disabled={!selections.length || !editValue.trim()}>Preview change</button><button className="button secondary" onClick={() => void editHistory("edit.undo")} disabled={!deltas.length}>Undo</button><button className="button secondary" onClick={() => void editHistory("edit.redo")}>Redo</button><button className="button danger" onClick={() => void editHistory("edit.discard")} disabled={!deltas.length}>Discard all</button></div>
                <div className="delta-card"><div><h3>Preview changes</h3><span>{deltas.length}</span></div>{deltas.length ? <ul>{deltas.map((delta) => <li key={delta.id}><strong>{friendlyCssProperty(delta.property)}</strong><span>{delta.previousValue || "default"} → {delta.value}</span><small>{shorten(delta.selector, 54)}</small></li>)}</ul> : <p>No temporary changes.</p>}</div>
                <div className="edit-stage"><span>3</span><div><strong>Save to project source</strong><p>The agent will inspect your code, propose edits, reload, and verify.</p></div></div>
                <button className="button apply-code full" onClick={() => void applyToCode()} disabled={!deltas.length || running || !chatReady}>{running ? "Saving…" : "Save preview to project (experimental)"}</button>
                <p className="hint">Review file approvals carefully. Temporary page styles remain until a successful reload explicitly clears them.</p>
              </>
            )}
          </div>
        )}

        {tab === "Connections" && (
          <div className="section-stack">
            <div className="section-heading"><div><h2>Connections</h2><p>See exactly which local parts are ready.</p></div><button className="button secondary compact" onClick={() => void refreshConnections()}>Check all</button></div>
            <ConnectionCard title="Local helper" status={checks.daemon} detail={connected ? `${settings.daemonUrl} is reachable` : `Start the helper at ${settings.daemonUrl}`} />
            <ConnectionCard title="Pairing token" status={accessReady ? "online" : connected ? "offline" : "unknown"} detail={accessReady ? "The extension is authenticated" : connected ? "Save the token printed by the local helper" : "Checked after the helper is reachable"}>
              {connected && !accessReady && <button className="button secondary" onClick={() => setTab("Settings")}>Open settings</button>}
            </ConnectionCard>
            <ConnectionCard title="Current page" status={checks.content} detail={activeTab.title ?? activeTab.url ?? "Open an ordinary localhost web page"} />
            <details className="disclosure connection-advanced">
              <summary>Advanced browser connection</summary>
              <div className="disclosure-content">
                <ConnectionCard title="Chrome debugger" status={checks.debugger} detail="Optional deeper inspection and screenshots">
                  <div className="button-row"><button className="button primary" onClick={() => void setDebugger(true)} disabled={!settings.cdpEnabled || checks.debugger === "attached"}>Attach</button><button className="button secondary" onClick={() => void setDebugger(false)} disabled={checks.debugger !== "attached"}>Detach</button></div>
                </ConnectionCard>
                <div className="warning"><strong>Chrome will show a debugger notice</strong><p>Opening DevTools for the same tab may disconnect this advanced adapter. Normal picking and preview editing do not require it.</p></div>
              </div>
            </details>
            <div className="planned-card"><span>Later</span><div><strong>GitHub connection</strong><p>Remote issues, pull requests, and CI are intentionally deferred until the local workflow is solid.</p></div></div>
          </div>
        )}

        {tab === "Settings" && (
          <div className="section-stack">
            <div className="section-heading"><div><h2>Settings</h2><p>Configure the trusted local helper and approval behavior.</p></div></div>
            <div className="form-card">
              <label htmlFor="daemon-url">Local helper URL<input id="daemon-url" value={settingsDraft.daemonUrl} onChange={(event) => setSettingsDraft({ ...settingsDraft, daemonUrl: event.target.value })} placeholder="http://127.0.0.1:3210" aria-describedby="daemon-url-help" /></label>
              <p className="field-help" id="daemon-url-help">Keep this on localhost. The default is usually correct.</p>
              <label htmlFor="daemon-token">Pairing token</label>
              <div className="input-with-action"><input id="daemon-token" type={showToken ? "text" : "password"} autoComplete="off" value={settingsDraft.token} onChange={(event) => setSettingsDraft({ ...settingsDraft, token: event.target.value })} placeholder="Paste the token printed in Command Prompt" /><button className="text-button" type="button" onClick={() => setShowToken((current) => !current)}>{showToken ? "Hide" : "Show"}</button></div>
              <p className="field-help">This authenticates the extension to the helper. It is never sent to the webpage.</p>
              <label htmlFor="approval-mode">Before making changes<select id="approval-mode" value={settingsDraft.approvalMode} onChange={(event) => setSettingsDraft({ ...settingsDraft, approvalMode: event.target.value as ExtensionSettings["approvalMode"] })}><option value="ask">Ask me before changes and commands</option><option value="auto-safe">Allow safe file changes; ask for commands</option><option value="deny">Read-only — deny all side effects</option></select></label>
            </div>
            <label className="toggle"><input type="checkbox" checked={settingsDraft.cdpEnabled} onChange={(event) => setSettingsDraft({ ...settingsDraft, cdpEnabled: event.target.checked })} /><span><strong>Enable advanced Chrome inspection</strong><small>Allows an optional debugger attachment only when you explicitly press Attach.</small></span></label>
            <button className="button primary full" onClick={() => void saveConfiguration()}>Save and reconnect</button>
            <div className="security-note"><strong>Local-only by design</strong><p>The helper accepts loopback HTTP only. Your OpenRouter key stays in the local process and is never bundled into this extension.</p></div>
          </div>
        )}
      </section>
    </main>
  );
}

function ReadinessCard(props: {
  readiness: ReturnType<typeof deriveReadiness>;
  onNavigate: (tab: TabName) => void;
}): ReactElement {
  return <section className="readiness-card" aria-labelledby="setup-title">
    <div className="readiness-heading"><div><span>Getting started</span><h3 id="setup-title">{props.readiness.summary}</h3></div><strong>{props.readiness.completed}/{props.readiness.total}</strong></div>
    <div className="progress-track" aria-hidden="true"><span style={{ width: `${(props.readiness.completed / props.readiness.total) * 100}%` }} /></div>
    <ol>
      {props.readiness.steps.map((step) => <li key={step.id} className={step.complete ? "complete" : ""}>
        <span className="step-check" aria-hidden="true">{step.complete ? "✓" : props.readiness.steps.indexOf(step) + 1}</span>
        <div><strong>{step.label}</strong>{!step.complete && <small>{step.actionLabel}</small>}</div>
        {!step.complete && <button className="text-button" onClick={() => props.onNavigate(step.targetTab)}>Set up</button>}
      </li>)}
    </ol>
  </section>;
}

function ConnectionCard(props: { title: string; status: string; detail: string; children?: ReactNode }): ReactElement {
  const titleId = `connection-${props.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return <article className="connection-card" aria-labelledby={titleId}>
    <div className="connection-card-head"><div><span className={`check-dot ${props.status}`} aria-hidden="true" /><h3 id={titleId}>{props.title}</h3></div><span>{connectionStatusLabel(props.status)}</span></div>
    <p>{props.detail}</p>{props.children}
  </article>;
}

function coreBlockerMessage(id: string): string {
  switch (id) {
    case "token": return "Add the pairing token from Command Prompt before starting a task.";
    case "daemon": return "Start the local helper and confirm the connection before starting a task.";
    case "model": return "Choose a tool-capable model before starting a task.";
    case "project": return "Choose the project folder the agent should work in before chatting.";
    default: return "Finish setup before starting a task.";
  }
}

function toolStatusLabel(status: ToolTimelineItem["status"]): string {
  switch (status) {
    case "running": return "In progress";
    case "approval": return "Needs approval";
    case "completed": return "Done";
    case "error": return "Failed";
    case "rejected": return "Rejected";
  }
}

function approvalModeLabel(mode: ExtensionSettings["approvalMode"]): string {
  if (mode === "ask") return "Ask before changes";
  if (mode === "auto-safe") return "Safe changes allowed";
  return "Read-only mode";
}

function connectionStatusLabel(status: string): string {
  if (["online", "ready", "attached"].includes(status)) return "Ready";
  if (["offline", "unavailable"].includes(status)) return "Unavailable";
  if (status === "detached") return "Not attached";
  return "Not checked";
}

function friendlyCssProperty(property: string): string {
  return property.replaceAll("-", " ").replace(/^./, (character) => character.toUpperCase());
}

function isContentEventMessage(value: unknown): value is { type: "content.event"; event: ContentEvent } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { type?: unknown; event?: unknown };
  if (candidate.type !== "content.event" || !candidate.event || typeof candidate.event !== "object") return false;
  const event = candidate.event as { type?: unknown; element?: unknown; elementId?: unknown; deltas?: unknown };
  switch (event.type) {
    case "selection.added":
      return isElementContext(event.element);
    case "selection.removed":
      return typeof event.elementId === "string" && event.elementId.length > 0;
    case "selection.cleared":
    case "picker.stopped":
      return true;
    case "preview.changed":
      return Array.isArray(event.deltas) && event.deltas.every(isEditDelta);
    default:
      return false;
  }
}

function isElementContext(value: unknown): value is ElementContext {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { id?: unknown; selector?: unknown; tagName?: unknown };
  return typeof candidate.id === "string" && typeof candidate.selector === "string" && typeof candidate.tagName === "string";
}

function isEditDelta(value: unknown): value is EditDelta {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { id?: unknown; selector?: unknown; property?: unknown; value?: unknown; timestamp?: unknown };
  return typeof candidate.id === "string"
    && typeof candidate.selector === "string"
    && typeof candidate.property === "string"
    && typeof candidate.value === "string"
    && typeof candidate.timestamp === "number";
}

function explicitlyDiscardsPreview(event: AgentEvent): boolean {
  if (event.discardPreview === true) return true;
  const result = event.result;
  if (!!result && typeof result === "object" && (result as { discardPreview?: unknown }).discardPreview === true) return true;
  if (event.type === "run.completed" && event.content) {
    try {
      const parsed = JSON.parse(event.content) as { discardPreview?: unknown };
      return parsed.discardPreview === true;
    } catch {
      return false;
    }
  }
  return false;
}

function buildDaemonContext(
  project: ProjectInfo,
  activeTab: ActiveTabInfo,
  elements: ElementContext[],
  previewDeltas: EditDelta[],
  attachment: Record<string, unknown>,
): Record<string, unknown> {
  const mappedElements = elements.map((element) => ({
    id: element.id,
    label: "<" + element.tagName + "> " + shorten(element.selector, 450),
    tag: element.tagName,
    locator: {
      selector: element.selector,
      backendNodeId: null,
      frameId: null,
      attributes: element.attributes,
      text: element.text || null,
      ancestry: element.selector.split(/\s*>\s*/).slice(-32),
    },
    classes: (element.attributes.class ?? "").split(/\s+/).filter(Boolean).slice(0, 200),
    bounds: element.rect,
    computedStyle: element.computedStyles,
    inlineStyle: element.inlineStyles,
    matchedRules: [],
    outerHTMLSnippet: element.outerHTMLSnippet,
  }));
  const visualChanges = previewDeltas.map((delta) => {
    const element = elements.find((candidate) => candidate.selector === delta.selector);
    return {
      id: delta.id,
      elementId: element?.id ?? delta.id,
      elementLabel: element ? "<" + element.tagName + "> " + shorten(element.selector, 450) : shorten(delta.selector, 500),
      operation: "style",
      styleDelta: {
        [delta.property]: {
          before: delta.previousValue || null,
          preview: delta.value || null,
        },
      },
      createdAt: new Date(delta.timestamp).toISOString(),
    };
  });
  const context: Record<string, unknown> = {
    elements: mappedElements,
    visualChanges,
    attachments: [attachment],
  };
  if (project.path) context.projectRoot = project.path;
  if (activeTab.url && isWebUrl(activeTab.url)) {
    context.activeTab = { url: activeTab.url, title: activeTab.title ?? activeTab.url };
  }
  return context;
}

function summarizeValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return shorten(value, 180);
  try {
    return shorten(JSON.stringify(value), 180);
  } catch {
    return String(value);
  }
}

function optionalText<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isLocalDevelopmentUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function formatConversationTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function basename(path?: string): string {
  if (!path) return "";
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? path;
}

function shorten(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}
