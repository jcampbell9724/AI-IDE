import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { AgentRunner } from "./agent-runner.js";
import { ApprovalManager } from "./approval-manager.js";
import { BrowserBridge } from "./browser-bridge.js";
import type { DaemonConfig } from "./config.js";
import { OpenRouterClient } from "./openrouter.js";
import { DevProcessManager } from "./process-manager.js";
import { ProjectService } from "./project-service.js";
import { ProjectStore } from "./project-store.js";
import { createDaemonServer } from "./server.js";
import { CodebaseMapFeature } from "./codebase-map/index.js";
import { RepositoryMemoryFeature } from "./repository-memory/index.js";

export type { DaemonConfig } from "./config.js";

export interface DaemonRuntimeOptions {
  readonly config: DaemonConfig;
  readonly fetchImpl?: typeof fetch;
  readonly codebaseMapWasmDirectory?: string;
}

export interface DaemonRuntime {
  readonly config: DaemonConfig;
  readonly store: ProjectStore;
  readonly projects: ProjectService;
  readonly processes: DevProcessManager;
  readonly approvals: ApprovalManager;
  readonly browser: BrowserBridge;
  readonly models: OpenRouterClient;
  readonly runner: AgentRunner;
  readonly codebaseMap: CodebaseMapFeature;
  readonly repositoryMemory: RepositoryMemoryFeature;
  readonly server: Server;
  setOpenRouterApiKey(apiKey: string | undefined): void;
  setCodebaseMapEnabled(enabled: boolean): void;
  setRepositoryMemoryEnabled(enabled: boolean): void;
  shutdown(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Creates the daemon services without loading environment files, opening a port,
 * installing signal handlers, or otherwise changing process-global state.
 */
export function createDaemonRuntime(options: DaemonRuntimeOptions): DaemonRuntime {
  const { config } = options;
  const store = new ProjectStore(config.stateFile);
  const projects = new ProjectService(store);
  const processes = new DevProcessManager();
  const approvals = new ApprovalManager();
  const browser = new BrowserBridge();
  const codebaseMap = new CodebaseMapFeature({
    cacheDirectory: join(dirname(config.stateFile), "codebase-map"),
    enabled: config.codebaseMapEnabled,
    ...(options.codebaseMapWasmDirectory === undefined
      ? {}
      : { wasmDirectory: options.codebaseMapWasmDirectory }),
  });
  const models = new OpenRouterClient({
    baseUrl: config.openRouterBaseUrl,
    title: config.openRouterTitle,
    ...(config.openRouterApiKey === undefined ? {} : { apiKey: config.openRouterApiKey }),
    ...(config.openRouterReferer === undefined ? {} : { referer: config.openRouterReferer }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const repositoryMemory = new RepositoryMemoryFeature({
    directory: join(dirname(config.stateFile), "repository-memory"),
    enabled: config.repositoryMemoryEnabled ?? false,
  });
  const runner = new AgentRunner(models, projects, approvals, browser, codebaseMap, repositoryMemory);
  const server = createDaemonServer({
    config,
    projects,
    processes,
    models,
    runner,
    approvals,
    browser,
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      runner.cancelAll();
      await processes.stop();
      await closeServer(server);
      codebaseMap.dispose();
    })();
    return shutdownPromise;
  };

  return {
    config,
    store,
    projects,
    processes,
    approvals,
    browser,
    models,
    runner,
    codebaseMap,
    repositoryMemory,
    server,
    setOpenRouterApiKey: (apiKey) => models.setApiKey(apiKey),
    setCodebaseMapEnabled: (enabled) => codebaseMap.setEnabled(enabled),
    setRepositoryMemoryEnabled: (enabled) => repositoryMemory.setEnabled(enabled),
    shutdown,
  };
}

export { sanitizedChildEnvironment } from "./child-env.js";
