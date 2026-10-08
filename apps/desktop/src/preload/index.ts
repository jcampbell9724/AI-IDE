import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent } from "@browser-agent/shared";
import type {
  BrowserBounds,
  CreateProjectInput,
  DesktopApi,
  DesktopSnapshot,
  SavePreferencesInput,
  SaveProjectFileInput,
  SelectProjectInput,
} from "../shared/contracts";

const api: DesktopApi = {
  copyText: (text) => ipcRenderer.invoke("desktop:copy-text", text),
  getSnapshot: () => ipcRenderer.invoke("desktop:get-snapshot"),
  savePreferences: (input: SavePreferencesInput) => ipcRenderer.invoke("desktop:save-preferences", input),
  chooseProject: () => ipcRenderer.invoke("desktop:choose-project"),
  createProject: (input: CreateProjectInput) => ipcRenderer.invoke("desktop:create-project", input),
  selectProject: (input: SelectProjectInput) => ipcRenderer.invoke("desktop:select-project", input),
  removeRecentProject: (path) => ipcRenderer.invoke("desktop:remove-recent-project", path),
  setProjectPinned: (path, pinned) => ipcRenderer.invoke("desktop:set-project-pinned", { path, pinned }),
  projectAction: (action) => ipcRenderer.invoke("desktop:project-action", action),
  getProjectLogs: (after) => ipcRenderer.invoke("desktop:project-logs", after),
  listProjectDirectory: () => ipcRenderer.invoke("desktop:list-project-directory"),
  readProjectFile: (path) => ipcRenderer.invoke("desktop:read-project-file", path),
  saveProjectFile: (input: SaveProjectFileInput) => ipcRenderer.invoke("desktop:save-project-file", input),
  listModels: (refresh = false) => ipcRenderer.invoke("desktop:list-models", refresh),
  navigate: (url) => ipcRenderer.invoke("desktop:navigate", url),
  browserAction: (action) => ipcRenderer.invoke("desktop:browser-action", action),
  pickElement: () => ipcRenderer.invoke("desktop:pick-element"),
  cancelElementPicker: () => ipcRenderer.invoke("desktop:cancel-element-picker"),
  setBrowserBounds: (bounds: BrowserBounds) => ipcRenderer.invoke("desktop:set-browser-bounds", bounds),
  runAgent: (request) => ipcRenderer.invoke("desktop:run-agent", request),
  cancelAgent: (runId) => ipcRenderer.invoke("desktop:cancel-agent", runId),
  decideApproval: (id, decision) => ipcRenderer.invoke("desktop:decide-approval", { id, decision }),
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AgentEvent): void => listener(payload);
    ipcRenderer.on("agent:event", wrapped);
    return () => ipcRenderer.removeListener("agent:event", wrapped);
  },
  onSnapshot: (listener: (snapshot: DesktopSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopSnapshot): void => listener(payload);
    ipcRenderer.on("desktop:snapshot", wrapped);
    return () => ipcRenderer.removeListener("desktop:snapshot", wrapped);
  },
};

contextBridge.exposeInMainWorld("browserAgent", api);
