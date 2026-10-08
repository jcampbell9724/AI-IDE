import { randomBytes } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AgentRunRequestSchema,
  ApprovalModeSchema,
  type AgentEvent,
  type ProjectRecord,
} from "@browser-agent/shared";
import {
  createDaemonRuntime,
  type DaemonConfig,
  type DaemonRuntime,
} from "@browser-agent/daemon";
import {
  app,
  clipboard,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  safeStorage,
  type IpcMainInvokeEvent,
} from "electron";
import { z } from "zod";
import { DesktopBrowser } from "./desktop-browser";
import { dispatchBrowserRequest } from "./browser-dispatch";
import { createProjectDirectory } from "./project-creation";
import { PROJECT_FILE_MAX_BYTES, readProjectCodeFile, saveProjectCodeFile } from "./project-files";
import {
  DesktopSettingsStore,
  type SecretCodec,
  type SettingsUpdate,
} from "./settings-store";
import type {
  BrowserBounds,
  CreateProjectInput,
  DesktopBrowserState,
  DesktopProject,
  DesktopProjectDirectory,
  DesktopProjectEntry,
  DesktopSnapshot,
  SavePreferencesInput,
  SelectProjectInput,
} from "../shared/contracts";
import { startWorkspaceRefresh } from "./workspace-refresh";
import { openProjectPreview } from "./project-preview";
import { PreviewStartup } from "./preview-startup";
import { StaticPreview } from "./static-preview";
import { ProjectActions } from "./project-actions";

// Keep the pre-Span data directory so existing settings and browser storage survive.
const legacyUserData = app.getPath("userData");
app.setPath("userData", legacyUserData);
app.setName("Span");
app.setAppUserModelId("com.browseragent.desktop");

const savePreferencesSchema = z.object({
  apiKey: z.string().max(10_000).optional(),
  clearApiKey: z.boolean().optional(),
  selectedModel: z.string().max(500).optional(),
  approvalMode: ApprovalModeSchema.optional(),
  launchAtLogin: z.boolean().optional(),
  codebaseMapEnabled: z.boolean().optional(),
  repositoryMemoryEnabled: z.boolean().optional(),
});
const selectProjectSchema = z.object({
  path: z.string().max(4096).optional(),
  devCommand: z.string().max(4096).optional(),
  url: z.string().max(4096).optional(),
});
const createProjectSchema = z.object({
  name: z.string().trim().min(1, "Enter a project name.").max(100),
});
const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
  visible: z.boolean(),
});
const projectFilePathSchema = z.string().trim().min(1).max(4096);
const saveProjectFileSchema = z.object({
  path: projectFilePathSchema,
  projectRoot: z.string().min(1).max(4096),
  content: z.string().max(PROJECT_FILE_MAX_BYTES).refine((value) => Buffer.byteLength(value, "utf8") <= PROJECT_FILE_MAX_BYTES),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const PROJECT_DIRECTORY_LIMIT = 2500;
const PROJECT_SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".next",
  ".pnpm-store",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

let mainWindow: BrowserWindow | undefined;
let browser: DesktopBrowser | undefined;
let runtime: DaemonRuntime | undefined;
let settings: DesktopSettingsStore | undefined;
let approvalNotification: Notification | undefined;
let shuttingDown = false;
let activeModel = "";
const previewStartup = new PreviewStartup(() => { void emitSnapshot().catch(() => undefined); });
const staticPreview = new StaticPreview();
const projectActions = new ProjectActions();

function requireRuntime(): DaemonRuntime {
  if (!runtime) throw new Error("The desktop runtime is not ready.");
  return runtime;
}

function requireSettings(): DesktopSettingsStore {
  if (!settings) throw new Error("Desktop settings are not ready.");
  return settings;
}

function requireBrowser(): DesktopBrowser {
  if (!browser) throw new Error("The desktop browser is not ready.");
  return browser;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Untrusted desktop IPC sender.");
  }
}

function secureCodec(): SecretCodec {
  const available = safeStorage.isEncryptionAvailable()
    && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
  const backend = process.platform === "win32"
    ? "Windows credential protection"
    : process.platform === "darwin"
      ? "macOS Keychain"
      : safeStorage.getSelectedStorageBackend();
  return {
    available,
    backend,
    encrypt: (value) => safeStorage.encryptStringAsync(value),
    decrypt: async (value) => {
      const decrypted = await safeStorage.decryptStringAsync(value);
      return { value: decrypted.result, shouldReEncrypt: decrypted.shouldReEncrypt };
    },
  };
}

async function currentProject(): Promise<DesktopProject> {
  const activeRuntime = requireRuntime();
  const state = await activeRuntime.projects.getState();
  const current = state.current;
  const status = activeRuntime.processes.status();
  return {
    path: current?.root ?? null,
    name: current?.detection.name ?? null,
    url: current?.url ?? null,
    devCommand: current?.devCommand ?? null,
    detection: current?.detection ?? null,
    ...(current?.devCommandSource === undefined ? {} : { devCommandSource: current.devCommandSource }),
    status: staticPreview.running ? "running" : status.state,
    pid: status.pid,
    previewStartup: previewStartup.state,
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}

async function snapshot(): Promise<DesktopSnapshot> {
  const stored = await requireSettings().load();
  const projectState = await requireRuntime().projects.getState();
  return {
    version: app.getVersion(),
    preferences: {
      apiKeyConfigured: Boolean(stored.encryptedApiKey),
      selectedModel: activeModel,
      approvalMode: stored.approvalMode,
      launchAtLogin: stored.launchAtLogin,
      codebaseMapEnabled: stored.codebaseMapEnabled,
      repositoryMemoryEnabled: stored.repositoryMemoryEnabled,
      secureStorageAvailable: requireSettings().codec.available,
      secureStorageBackend: requireSettings().codec.backend,
    },
    project: await currentProject(),
    recentProjects: projectState.recent.map((project) => ({
      path: project.root,
      name: project.detection.name,
      devCommand: project.devCommand,
      url: project.url,
      pinned: projectState.pinned.includes(project.root),
    })),
    browser: requireBrowser().state(),
  };
}

async function emitSnapshot(): Promise<DesktopSnapshot> {
  const next = await snapshot();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:snapshot", next);
  return next;
}

function emitAgentEvent(event: AgentEvent): void {
  if (event.type === "browser.request") {
    void dispatchBrowserRequest(event.request, requireRuntime().browser, requireBrowser());
  }
  if (event.type === "approval.required") notifyApproval(event.summary);
  if (event.type === "approval.resolved") {
    approvalNotification?.close();
    approvalNotification = undefined;
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent:event", event);
}

function notifyApproval(summary: string): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.isFocused() || !Notification.isSupported()) return;
  approvalNotification?.close();
  const notification = new Notification({
    title: "Span needs your approval",
    body: summary.slice(0, 240),
  });
  approvalNotification = notification;
  notification.on("click", () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  notification.on("close", () => {
    if (approvalNotification === notification) approvalNotification = undefined;
  });
  notification.show();
}

async function selectProject(input: SelectProjectInput): Promise<DesktopProject> {
  const activeRuntime = requireRuntime();
  assertProjectCanSwitch(activeRuntime);
  previewStartup.cancel();
  const current = (await activeRuntime.projects.getState()).current;
  const requestedPath = input.path?.trim();
  const path = requestedPath || current?.root;
  if (!path) throw new Error("Choose a project folder first.");
  const editingCurrentProject = !requestedPath || requestedPath === current?.root;
  // Never preserve a stale preview URL here: the daemon keeps the saved URL
  // on reopen but clears it when the run command explicitly changes. Passing
  // only an explicit URL avoids resurrecting an old address after a command
  // edit or a switch to another project.
  await activeRuntime.projects.select({
    path,
    ...(input.devCommand === undefined ? {} : { devCommand: input.devCommand.trim() }),
    ...(input.url?.trim() ? { url: input.url.trim() } : {}),
  });
  activeRuntime.processes.clearLogs();
  const project = await currentProject();
  if (!editingCurrentProject) await requireBrowser().reset();
  if (project.url) {
    // Selection already succeeded; a preview that is not yet reachable must
    // not fail the switch. The snapshot still carries the saved URL so the
    // user can retry once the server is up.
    await requireBrowser().navigate(project.url).catch(() => undefined);
  }
  await emitSnapshot();
  return project;
}

function assertProjectCanSwitch(activeRuntime: DaemonRuntime): void {
  projectActions.assertIdle();
  activeRuntime.projects.assertCanSelect();
  const status = activeRuntime.processes.status().state;
  if (staticPreview.running || !["stopped", "failed"].includes(status)) {
    throw new Error("Stop the current project before switching projects.");
  }
}

async function listProjectDirectory(): Promise<DesktopProjectDirectory> {
  const workspace = await requireRuntime().projects.workspace();
  const entries: DesktopProjectEntry[] = [];

  const visit = async (directory: string, depth: number): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    });

    for (const child of children) {
      if (entries.length >= PROJECT_DIRECTORY_LIMIT) return;
      const absolutePath = join(directory, child.name);
      const info = await lstat(absolutePath);
      const path = workspace.relative(absolutePath).replaceAll("\\", "/");
      if (info.isSymbolicLink()) {
        entries.push({ path, name: child.name, kind: "symlink", depth });
      } else if (info.isDirectory()) {
        entries.push({ path, name: child.name, kind: "directory", depth });
        if (!PROJECT_SKIPPED_DIRECTORIES.has(child.name)) await visit(absolutePath, depth + 1);
      } else if (info.isFile()) {
        entries.push({ path, name: child.name, kind: "file", depth, size: info.size });
      }
    }
  };

  await visit(workspace.root, 0);
  return {
    rootName: basename(workspace.root),
    entries,
    truncated: entries.length >= PROJECT_DIRECTORY_LIMIT,
  };
}

function registerIpc(): void {
  ipcMain.handle("desktop:copy-text", async (event, raw: unknown) => {
    assertTrustedSender(event);
    clipboard.writeText(z.string().max(200_000).parse(raw));
  });
  ipcMain.handle("desktop:get-snapshot", async (event) => {
    assertTrustedSender(event);
    return snapshot();
  });
  ipcMain.handle("desktop:save-preferences", async (event, raw: SavePreferencesInput) => {
    assertTrustedSender(event);
    const parsed = savePreferencesSchema.parse(raw);
    const input: SettingsUpdate = {
      ...(parsed.selectedModel === undefined ? {} : { selectedModel: parsed.selectedModel.trim() }),
      ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
      ...(parsed.clearApiKey === undefined ? {} : { clearApiKey: parsed.clearApiKey }),
      ...(parsed.approvalMode === undefined ? {} : { approvalMode: parsed.approvalMode }),
      ...(parsed.launchAtLogin === undefined ? {} : { launchAtLogin: parsed.launchAtLogin }),
      ...(parsed.codebaseMapEnabled === undefined ? {} : { codebaseMapEnabled: parsed.codebaseMapEnabled }),
      ...(parsed.repositoryMemoryEnabled === undefined ? {} : { repositoryMemoryEnabled: parsed.repositoryMemoryEnabled }),
    };
    const stored = await requireSettings().update(input);
    activeModel = stored.selectedModel;
    requireRuntime().setOpenRouterApiKey(await requireSettings().getApiKey());
    if (input.launchAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: stored.launchAtLogin });
    }
    if (input.codebaseMapEnabled !== undefined) {
      requireRuntime().setCodebaseMapEnabled(stored.codebaseMapEnabled);
    }
    if (input.repositoryMemoryEnabled !== undefined) {
      requireRuntime().setRepositoryMemoryEnabled(stored.repositoryMemoryEnabled);
    }
    return emitSnapshot();
  });
  ipcMain.handle("desktop:choose-project", async (event) => {
    assertTrustedSender(event);
    if (!mainWindow) throw new Error("The application window is unavailable.");
    assertProjectCanSwitch(requireRuntime());
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a project folder",
      buttonLabel: "Use this folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return currentProject();
    return selectProject({ path: result.filePaths[0] });
  });
  ipcMain.handle("desktop:create-project", async (event, raw: CreateProjectInput) => {
    assertTrustedSender(event);
    if (!mainWindow) throw new Error("The application window is unavailable.");
    assertProjectCanSwitch(requireRuntime());
    const input = createProjectSchema.parse(raw);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `Choose where to create ${input.name.trim() || "the new project"}`,
      buttonLabel: "Create project here",
      defaultPath: app.getPath("documents"),
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return currentProject();
    const projectPath = await createProjectDirectory(result.filePaths[0], input.name);
    return selectProject({ path: projectPath });
  });
  ipcMain.handle("desktop:select-project", async (event, raw: SelectProjectInput) => {
    assertTrustedSender(event);
    const parsed = selectProjectSchema.parse(raw);
    return selectProject({
      ...(parsed.path === undefined ? {} : { path: parsed.path }),
      ...(parsed.devCommand === undefined ? {} : { devCommand: parsed.devCommand }),
      ...(parsed.url === undefined ? {} : { url: parsed.url }),
    });
  });
  ipcMain.handle("desktop:remove-recent-project", async (event, raw: unknown) => {
    assertTrustedSender(event);
    const path = z.string().trim().min(1).max(4096).parse(raw);
    await requireRuntime().projects.removeRecent(path);
    return emitSnapshot();
  });
  ipcMain.handle("desktop:set-project-pinned", async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = z.object({
      path: z.string().trim().min(1).max(4096),
      pinned: z.boolean(),
    }).parse(raw);
    await requireRuntime().projects.setPinned(input.path, input.pinned);
    return emitSnapshot();
  });
  ipcMain.handle("desktop:project-action", async (event, raw: unknown) => {
    assertTrustedSender(event);
    const action = z.enum(["start", "stop", "restart"]).parse(raw);
    const activeRuntime = requireRuntime();
    await projectActions.run(action, {
      projects: activeRuntime.projects,
      processes: activeRuntime.processes,
      staticPreview,
      previewStartup,
      navigate: (url, signal) => requireBrowser().navigate(url, signal),
      emitSnapshot,
    });
    return currentProject();
  });
  ipcMain.handle("desktop:project-logs", async (event, raw: unknown) => {
    assertTrustedSender(event);
    const after = z.number().int().nonnegative().parse(raw);
    return requireRuntime().processes.logsAfter(after);
  });
  ipcMain.handle("desktop:list-project-directory", async (event) => {
    assertTrustedSender(event);
    return listProjectDirectory();
  });
  ipcMain.handle("desktop:read-project-file", async (event, raw: unknown) => {
    assertTrustedSender(event);
    const requestedPath = projectFilePathSchema.parse(raw);
    return readProjectCodeFile(await requireRuntime().projects.workspace(), requestedPath);
  });
  ipcMain.handle("desktop:save-project-file", async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = saveProjectFileSchema.parse(raw);
    return saveProjectCodeFile(() => requireRuntime().projects.workspace(), input);
  });
  ipcMain.handle("desktop:list-models", async (event, raw: unknown) => {
    assertTrustedSender(event);
    const refresh = z.boolean().optional().parse(raw) ?? false;
    return requireRuntime().models.listModels(refresh);
  });
  ipcMain.handle("desktop:navigate", async (event, raw: unknown) => {
    assertTrustedSender(event);
    previewStartup.cancel();
    try {
      return await openProjectPreview(requireRuntime().projects,
        (url) => requireBrowser().navigate(url), z.string().max(4096).parse(raw));
    } finally {
      await emitSnapshot();
    }
  });
  ipcMain.handle("desktop:browser-action", async (event, raw: unknown) => {
    assertTrustedSender(event);
    return requireBrowser().simpleAction(z.enum(["back", "forward", "reload"]).parse(raw));
  });
  ipcMain.handle("desktop:pick-element", async (event) => {
    assertTrustedSender(event);
    return requireBrowser().pickElement();
  });
  ipcMain.handle("desktop:cancel-element-picker", async (event) => {
    assertTrustedSender(event);
    return requireBrowser().cancelElementPicker();
  });
  ipcMain.handle("desktop:set-browser-bounds", async (event, raw: BrowserBounds) => {
    assertTrustedSender(event);
    if (!mainWindow) return;
    const bounds = boundsSchema.parse(raw);
    requireBrowser().setBounds(bounds, mainWindow.getContentBounds());
  });
  ipcMain.handle("desktop:run-agent", async (event, raw: unknown) => {
    assertTrustedSender(event);
    const request = AgentRunRequestSchema.parse(raw);
    void requireRuntime().runner.run(request, emitAgentEvent)
      .catch((error: unknown) => emitAgentEvent({
        type: "run.error",
        runId: request.runId,
        timestamp: new Date().toISOString(),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 20_000),
      }))
      .finally(() => void emitSnapshot());
    return { accepted: true as const };
  });
  ipcMain.handle("desktop:cancel-agent", async (event, raw: unknown) => {
    assertTrustedSender(event);
    const runId = z.string().uuid().parse(raw);
    return { cancelled: requireRuntime().runner.cancel(runId) };
  });
  ipcMain.handle("desktop:decide-approval", async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = z.object({ id: z.string().uuid(), decision: z.enum(["approve", "reject"]) }).parse(raw);
    return { resolved: requireRuntime().approvals.decide(input.id, input.decision) };
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 600,
    minHeight: 600,
    show: false,
    title: "Span",
    icon: app.isPackaged ? join(process.resourcesPath, "span.png") : join(__dirname, "../../build/span.png"),
    backgroundColor: "#faf9f6",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  browser = new DesktopBrowser((next: DesktopBrowserState) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("desktop:browser-state", next);
      void emitSnapshot();
    }
  });
  mainWindow.contentView.addChildView(browser.view);
  mainWindow.once("ready-to-show", () => mainWindow?.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

async function start(): Promise<void> {
  const userData = app.getPath("userData");
  settings = new DesktopSettingsStore(join(userData, "settings.json"), secureCodec());
  const stored = await settings.load();
  const apiKey = await settings.getApiKey();
  const config: DaemonConfig = {
    host: "127.0.0.1",
    port: 0,
    bearerToken: randomBytes(32).toString("base64url"),
    generatedBearerToken: true,
    stateFile: join(userData, "projects.json"),
    openRouterBaseUrl: "https://openrouter.ai/api/v1",
    openRouterTitle: "Span Desktop",
    allowedOrigins: [],
    codebaseMapEnabled: stored.codebaseMapEnabled,
    repositoryMemoryEnabled: stored.repositoryMemoryEnabled,
    ...(apiKey === undefined ? {} : { openRouterApiKey: apiKey }),
  };
  runtime = createDaemonRuntime({
    config,
    codebaseMapWasmDirectory: app.isPackaged
      ? join(process.resourcesPath, "codebase-map", "wasm")
      : join(app.getAppPath(), "../daemon/node_modules/@vscode/tree-sitter-wasm/wasm"),
  });
  await runtime.projects.clearCurrent();
  activeModel = stored.selectedModel;
  app.setLoginItemSettings({ openAtLogin: stored.launchAtLogin });
  registerIpc();
  await createWindow();
}

const refreshingWorkspace = startWorkspaceRefresh({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  argv: process.argv,
  processId: process.pid,
  exit: () => app.exit(0),
  relaunchCurrent: () => app.relaunch({
    args: [
      ...process.argv.slice(1).filter((argument) => argument !== "--workspace-refresh-complete"),
      "--workspace-refresh-complete",
    ],
  }),
});

if (refreshingWorkspace) {
  // The detached updater relaunches this executable after rebuilding and syncing it.
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(start).catch((error: unknown) => {
    dialog.showErrorBox("Span could not start", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}

app.on("activate", () => {
  if (!mainWindow) void createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  previewStartup.cancel();
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  void (async () => {
    await staticPreview.stop();
    browser?.destroy();
    await runtime?.shutdown();
    app.quit();
  })();
});
