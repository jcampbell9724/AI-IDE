import { normalizeDaemonUrl } from "./settings";
import { readAgentEvents } from "./sse";
import type {
  AgentEvent,
  AgentRunRequest,
  ModelInfo,
  ProjectInfo,
  ProjectLog,
} from "./types";

interface JsonRequestOptions extends RequestInit {
  timeoutMs?: number;
}

interface ParsedDaemonError {
  readonly message: string;
  readonly code?: string;
  readonly issues?: unknown;
}

export class DaemonApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly issues: unknown;

  constructor(message: string, status: number, code?: string, issues?: unknown) {
    super(message);
    this.name = "DaemonApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export class DaemonClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = normalizeDaemonUrl(baseUrl);
    this.token = token;
  }

  update(baseUrl: string, token: string): void {
    this.baseUrl = normalizeDaemonUrl(baseUrl);
    this.token = token;
  }

  async health(): Promise<Record<string, unknown>> {
    return this.json("/health", { auth: false } as JsonRequestOptions & { auth: boolean });
  }

  async listModels(refresh = false): Promise<ModelInfo[]> {
    const payload = await this.json<unknown>("/v1/models" + (refresh ? "?refresh=1" : ""));
    if (Array.isArray(payload)) return payload as ModelInfo[];
    const wrapped = payload as { models?: ModelInfo[] };
    return wrapped.models ?? [];
  }

  getProject(): Promise<ProjectInfo> {
    return this.json<ProjectInfo>("/v1/project");
  }

  selectProject(input: { path: string; devCommand?: string; url?: string }): Promise<ProjectInfo> {
    return this.json<ProjectInfo>("/v1/project/select", { method: "POST", body: JSON.stringify(input) });
  }

  projectAction(action: "start" | "stop" | "restart"): Promise<ProjectInfo> {
    return this.json<ProjectInfo>("/v1/project/" + action, { method: "POST" });
  }

  async projectLogs(after: number): Promise<{ logs: ProjectLog[]; next: number }> {
    const payload = await this.json<unknown>("/v1/project/logs?after=" + encodeURIComponent(String(after)));
    if (Array.isArray(payload)) {
      const logs = payload as ProjectLog[];
      return { logs, next: logs.at(-1)?.seq ?? after };
    }
    const wrapped = payload as { logs?: ProjectLog[]; next?: number };
    const logs = wrapped.logs ?? [];
    return { logs, next: wrapped.next ?? logs.at(-1)?.seq ?? after };
  }

  async *runAgent(request: AgentRunRequest, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const response = await this.fetch("/v1/agent/run", {
      method: "POST",
      body: JSON.stringify(request),
      headers: { Accept: "text/event-stream" },
      ...(signal ? { signal } : {}),
    });
    let terminal = false;
    for await (const event of readAgentEvents(response, signal)) {
      if (event.type === "run.completed" || event.type === "run.error" || event.type === "run.cancelled") {
        terminal = true;
      }
      yield event;
    }
    if (!terminal && !signal?.aborted) {
      throw new DaemonApiError(
        "The agent connection ended before the run finished. Try the request again.",
        502,
        "EVENT_STREAM_INCOMPLETE",
      );
    }
  }

  cancelRun(runId: string): Promise<Record<string, unknown>> {
    return this.json("/v1/agent/cancel", { method: "POST", body: JSON.stringify({ runId }) });
  }

  resolveApproval(id: string, decision: "approve" | "reject"): Promise<Record<string, unknown>> {
    return this.json("/v1/approvals/" + encodeURIComponent(id), {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  }

  submitBrowserResult(id: string, outcome: { result?: unknown; error?: string }): Promise<Record<string, unknown>> {
    return this.json("/v1/browser/results/" + encodeURIComponent(id), {
      method: "POST",
      body: JSON.stringify(outcome),
    });
  }

  private async json<T = Record<string, unknown>>(
    path: string,
    options: JsonRequestOptions & { auth?: boolean } = {},
  ): Promise<T> {
    const response = await this.fetch(path, options);
    if (response.status === 204) return {} as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new DaemonApiError(
        "The local daemon returned an invalid JSON response. Check its logs and try again.",
        response.status,
        "INVALID_RESPONSE",
      );
    }
  }

  private async fetch(path: string, options: JsonRequestOptions & { auth?: boolean } = {}): Promise<Response> {
    const { timeoutMs = 15_000, auth = true, ...requestOptions } = options;
    const controller = new AbortController();
    const timeout = requestOptions.signal ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    const signal = requestOptions.signal ?? controller.signal;
    const headers = new Headers(requestOptions.headers);
    if (requestOptions.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (auth && this.token) headers.set("Authorization", "Bearer " + this.token);

    try {
      const response = await fetch(this.baseUrl + path, { ...requestOptions, headers, signal });
      if (!response.ok) {
        throw await daemonApiError(response);
      }
      return response;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

export function readableError(error: unknown): string {
  if (error instanceof Error) {
    if (isNetworkFetchError(error)) {
      return "Couldn’t reach the local daemon. Make sure it is running and the URL in Settings is correct.";
    }
    return error.message;
  }
  return String(error);
}

async function daemonApiError(response: Response): Promise<DaemonApiError> {
  const rawBody = await response.text().catch(() => "");
  const parsed = parseDaemonError(rawBody);
  return new DaemonApiError(
    parsed?.message ?? fallbackDaemonMessage(response.status, response.statusText),
    response.status,
    parsed?.code,
    parsed?.issues,
  );
}

function parseDaemonError(rawBody: string): ParsedDaemonError | undefined {
  const body = rawBody.trim();
  if (!body) return undefined;

  try {
    const payload: unknown = JSON.parse(body);
    if (!isRecord(payload)) return undefined;

    const nested = payload.error;
    if (typeof nested === "string" && nested.trim()) {
      return { message: nested.trim() };
    }
    if (isRecord(nested)) {
      const message = stringValue(nested.message);
      if (message) {
        const code = stringValue(nested.code);
        return {
          message,
          ...(code ? { code } : {}),
          ...(Object.hasOwn(nested, "issues") ? { issues: nested.issues } : {}),
        };
      }
    }

    const message = stringValue(payload.message);
    if (message) return { message };
    return undefined;
  } catch {
    const message = safePlainText(body);
    return message ? { message } : undefined;
  }
}

function fallbackDaemonMessage(status: number, statusText: string): string {
  if (status === 401) {
    return "The local daemon rejected the request. Check the bearer token in Settings and try again.";
  }
  if (status === 403) {
    return "The local daemon refused this request. Check its origin and security settings.";
  }
  if (status === 404) {
    return "The local daemon does not support this request. Rebuild and restart the daemon, then try again.";
  }
  if (status >= 500) {
    return `The local daemon reported an internal error (${status}). Check its logs and try again.`;
  }
  const label = statusText.trim();
  return `The local daemon rejected the request (${status}${label ? ` ${label}` : ""}).`;
}

function safePlainText(value: string): string | undefined {
  if (/^\s*</.test(value)) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 499)}…`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNetworkFetchError(error: Error): boolean {
  return error instanceof TypeError && /failed to fetch|network(?:error| request failed)|load failed/i.test(error.message);
}
