import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, resolve } from "node:path";
import {
  AgentCancelRequestSchema,
  AgentEventSchema,
  AgentRunRequestSchema,
  ApprovalDecisionSchema,
  BrowserResultInputSchema,
  ProjectSelectionRequestSchema,
  type AgentEvent,
  type ProjectView,
} from "@browser-agent/shared";
import { z } from "zod";
import { AgentRunner } from "./agent-runner.js";
import { ApprovalManager } from "./approval-manager.js";
import { BrowserBridge } from "./browser-bridge.js";
import type { DaemonConfig } from "./config.js";
import { AppError, errorMessage } from "./errors.js";
import { OpenRouterClient } from "./openrouter.js";
import { DevProcessManager } from "./process-manager.js";
import { ProjectService } from "./project-service.js";

export interface DaemonDependencies {
  readonly config: DaemonConfig;
  readonly projects: ProjectService;
  readonly processes: DevProcessManager;
  readonly models: OpenRouterClient;
  readonly runner: AgentRunner;
  readonly approvals: ApprovalManager;
  readonly browser: BrowserBridge;
}

function setCors(request: IncomingMessage, response: ServerResponse, config: DaemonConfig): void {
  const origin = request.headers.origin;
  if (!origin) return;
  const allowed =
    origin.startsWith("chrome-extension://") || config.allowedOrigins.includes(origin);
  if (!allowed) {
    throw new AppError("ORIGIN_DENIED", "Request origin is not allowed", 403);
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function authorized(request: IncomingMessage, token: string): boolean {
  const prefix = "Bearer ";
  const header = request.headers.authorization;
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(request: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > maxBytes) throw new AppError("BODY_TOO_LARGE", "Request body is too large", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("INVALID_JSON", "Request body must be valid JSON");
  }
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError("VALIDATION_FAILED", "Request validation failed", 400, result.error.issues);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function projectView(deps: DaemonDependencies): Promise<ProjectView> {
  const projectState = await deps.projects.getState();
  const project = projectState.current;
  const status = deps.processes.status();
  const startupDirectory = resolve(process.env.INIT_CWD?.trim() || process.cwd());
  const candidateRecords = [
    ...(project ? [project] : []),
    ...projectState.recent,
    { root: startupDirectory, detection: { name: basename(startupDirectory) } },
  ];
  const seen = new Set<string>();
  const candidates = candidateRecords.flatMap((candidate) => {
    const key = candidate.root.toLocaleLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ path: candidate.root, name: candidate.detection.name }];
  }).slice(0, 20);
  return {
    path: project?.root ?? null,
    name: project?.detection.name ?? null,
    url: project?.url ?? null,
    devCommand: project?.devCommand ?? null,
    status: status.state,
    pid: status.pid,
    candidates,
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    if (!response.writableEnded) response.end();
    return;
  }
  if (error instanceof AppError) {
    sendJson(response, error.status, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { issues: error.details }),
      },
    });
    return;
  }
  sendJson(response, 500, {
    error: { code: "INTERNAL_ERROR", message: errorMessage(error) },
  });
}

export function createDaemonServer(deps: DaemonDependencies): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, deps).catch((error) => sendError(response, error));
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: DaemonDependencies,
): Promise<void> {
  setCors(request, response, deps.config);
  const url = new URL(request.url ?? "/", `http://${deps.config.host}:${deps.config.port}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true, service: "browser-agent-daemon", version: "0.1.0" });
    return;
  }

  if (!authorized(request, deps.config.bearerToken)) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="browser-agent-daemon"');
    throw new AppError("UNAUTHORIZED", "A valid bearer token is required", 401);
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    const models = await deps.models.listModels(url.searchParams.get("refresh") === "1");
    sendJson(response, 200, models);
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/project") {
    sendJson(response, 200, await projectView(deps));
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/project/select") {
    const processState = deps.processes.status().state;
    if (["starting", "running", "restarting", "stopping"].includes(processState)) {
      throw new AppError("PROCESS_RUNNING", "Stop the current development process before selecting another project", 409);
    }
    const input = parseWith(ProjectSelectionRequestSchema, await readJson(request));
    await deps.projects.select(input);
    deps.processes.clearLogs();
    sendJson(response, 200, await projectView(deps));
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/project/start") {
    const command = await deps.projects.ensureDevCommand();
    if (!command) {
      throw new AppError("DEV_COMMAND_MISSING", "No development command is configured", 409);
    }
    await deps.processes.start(await deps.projects.workspace(), command);
    sendJson(response, 200, await projectView(deps));
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/project/stop") {
    await deps.processes.stop();
    sendJson(response, 200, await projectView(deps));
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/project/restart") {
    const command = await deps.projects.ensureDevCommand();
    if (!command) {
      throw new AppError("DEV_COMMAND_MISSING", "No development command is configured", 409);
    }
    await deps.processes.restart(await deps.projects.workspace(), command);
    sendJson(response, 200, await projectView(deps));
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/project/logs") {
    const afterValue = url.searchParams.get("after") ?? "0";
    const after = Number(afterValue);
    if (!Number.isInteger(after) || after < 0) {
      throw new AppError("INVALID_AFTER", "after must be a non-negative integer");
    }
    sendJson(response, 200, deps.processes.logsAfter(after));
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/agent/run") {
    const input = parseWith(AgentRunRequestSchema, await readJson(request));
    if (deps.runner.has(input.runId)) {
      throw new AppError("RUN_ALREADY_ACTIVE", "A run with this ID is already active", 409);
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    let finished = false;
    const keepAlive = setInterval(() => {
      if (!response.destroyed) response.write(": keep-alive\n\n");
    }, 15_000);
    keepAlive.unref();
    const emit = (event: AgentEvent): void => {
      if (response.destroyed || response.writableEnded) return;
      const validated = AgentEventSchema.parse(event);
      response.write(`event: ${validated.type}\ndata: ${JSON.stringify(validated)}\n\n`);
    };
    response.on("close", () => {
      clearInterval(keepAlive);
      if (!finished) deps.runner.cancel(input.runId);
    });
    await deps.runner.run(input, emit);
    finished = true;
    clearInterval(keepAlive);
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/agent/cancel") {
    const input = parseWith(AgentCancelRequestSchema, await readJson(request));
    const cancelled = deps.runner.cancel(input.runId);
    sendJson(response, cancelled ? 202 : 404, { runId: input.runId, cancelled });
    return;
  }

  const approvalMatch = /^\/v1\/approvals\/([^/]+)$/.exec(url.pathname);
  if (request.method === "POST" && approvalMatch) {
    const id = decodeURIComponent(approvalMatch[1] ?? "");
    const input = parseWith(ApprovalDecisionSchema, await readJson(request));
    const resolved = deps.approvals.decide(id, input.decision);
    if (!resolved) throw new AppError("APPROVAL_NOT_FOUND", "Approval request was not found", 404);
    sendJson(response, 200, { id, decision: input.decision });
    return;
  }

  const browserResultMatch = /^\/v1\/browser\/results\/([^/]+)$/.exec(url.pathname);
  if (request.method === "POST" && browserResultMatch) {
    const id = decodeURIComponent(browserResultMatch[1] ?? "");
    const input = parseWith(BrowserResultInputSchema, await readJson(request));
    const resolved = deps.browser.resolve(id, input);
    if (!resolved) throw new AppError("BROWSER_REQUEST_NOT_FOUND", "Browser request was not found", 404);
    sendJson(response, 200, { id, accepted: true });
    return;
  }

  throw new AppError("NOT_FOUND", "Route not found", 404);
}
