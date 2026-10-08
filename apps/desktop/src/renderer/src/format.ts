/**
 * Display helpers: cost/price formatting, run summaries, friendly tool labels,
 * and human-readable agent error descriptions with retry guidance.
 */

export interface RunCostEstimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number | null;
}

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * OpenRouter model endpoints have historically reported prices inconsistently:
 * some as USD per 1M tokens ("0.15"), others as USD per token ("0.00000015").
 * Normalize to USD per 1M tokens for display and costing.
 */
export function pricePerMillion(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= 0) return 0;
  return parsed >= 0.001 ? parsed : parsed * 1_000_000;
}

export function formatPrice(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "Free";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

export function estimateRunCost(
  usage: unknown,
  promptPrice: string | null | undefined,
  completionPrice: string | null | undefined,
): RunCostEstimate {
  const record = (usage ?? {}) as Record<string, unknown>;
  const inputTokens = numberOr(record.prompt_tokens) ?? 0;
  const outputTokens = numberOr(record.completion_tokens) ?? 0;
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens === 0) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null };
  }
  const inputCostUsd = (pricePerMillion(promptPrice) ?? 0) * (inputTokens / 1_000_000);
  const outputCostUsd = (pricePerMillion(completionPrice) ?? 0) * (outputTokens / 1_000_000);
  return { inputTokens, outputTokens, totalTokens, costUsd: inputCostUsd + outputCostUsd };
}

export function formatCostUsd(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "≈$0.0000";
  if (value < 0.0001) return "<$0.0001";
  return `≈$${value.toFixed(4)}`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

const TOOL_LABELS: Readonly<Record<string, string>> = {
  repository_memory: "Save repository memory",
  codebase_map: "Explore codebase map",
  fs_list: "List files",
  fs_read: "Read file",
  fs_search: "Search files",
  fs_replace: "Edit file",
  fs_write: "Write file",
  git_status: "Git status",
  git_diff: "View diff",
  git_log: "Git history",
  shell_run: "Run command",
  browser: "Browser",
  write: "File edit",
  command: "Run command",
  browser_side_effect: "Browser action",
};

export function friendlyToolLabel(value: string): string {
  const known = TOOL_LABELS[value];
  if (known) return known;
  if (!value) return "Tool";
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^./, (character) => character.toUpperCase());
}

export function formatValue(value: unknown, maxChars = 8000): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (${text.length - maxChars} more characters)`;
}

export interface AgentErrorInfo {
  readonly title: string;
  readonly detail: string;
  readonly technicalDetail?: string;
  readonly retryable: boolean;
  readonly recovery?: "api-key" | "model" | "request";
  readonly operation?: "models";
}

export function describeAgentError(code: string | undefined, message: string): AgentErrorInfo {
  const technicalDetail = message.slice(0, 2000);
  const looksTransient = /(429|5\d{2}|timeout|timed out|temporar|rate limit|overloaded|unavailable|busy|network|econnreset|econnrefused)/i.test(message);
  const looksTechnical = /(openrouter|provider|api|callback|http|fetch|ipc|json|econn|status\s*code|request id)/i.test(message);

  if (code === "OPENROUTER_KEY_MISSING" || /\b(401|403)\b|invalid.{0,15}(api.?key|credentials)|unauthorized|authentication failed/i.test(message)) {
    return { title: "Check your OpenRouter key", detail: "The provider could not authorize this request. Review your API key and its permissions, then try again.", technicalDetail, retryable: false, recovery: "api-key" };
  }
  if (/\b402\b|insufficient (credits|balance)|payment required/i.test(message)) {
    return { title: "Provider credit required", detail: "Check your OpenRouter balance or spending limit before sending another request.", technicalDetail, retryable: false };
  }
  if (code === "MODEL_VISION_UNSUPPORTED" || /model.{0,60}(not found|unavailable|unsupported)|no endpoints|does not support.{0,30}(tools|images|vision)/i.test(message)) {
    return { title: "Choose another model", detail: "This model is unavailable or does not support the capabilities this request needs.", technicalDetail, retryable: false, recovery: "model" };
  }

  switch (code) {
    case "MEMORY_HANDOFF_REQUIRED":
      return { title: "Task progress needs a handoff", detail: "The agent did not save its progress. Retry to finish the handoff, or turn repository memory off in Preferences to continue without it.", technicalDetail, retryable: true, recovery: "request" };
    case "MEMORY_SESSION_INACTIVE":
      return { title: "Memory settings changed", detail: "Send the request again to load a fresh memory context with your current settings.", retryable: true, recovery: "request" };
    case "MEMORY_STATE_INVALID":
      return { title: "Saved memory could not be loaded", detail: "Your saved memory was retained. Turn repository memory off in Preferences to keep working while you repair the saved file.", technicalDetail, retryable: false };
    case "MODEL_CALL_FAILED":
      return {
        title: "Model request failed",
        detail: looksTransient
          ? "The model provider is temporarily unavailable. Wait a moment and try again."
          : "The model provider could not complete the request. Try again or choose a different model.",
        technicalDetail,
        retryable: true,
        recovery: "model",
      };
    case "MODEL_COMPLETION_ERROR":
      return { title: "Model stopped mid-response", detail: "The provider ended the response early. Review the response and activity before continuing.", technicalDetail, retryable: true, recovery: "model" };
    case "MODEL_RESPONSE_EMPTY":
      return { title: "Empty model response", detail: "The model returned no usable output. Retry the request or choose a different tool-capable model.", technicalDetail, retryable: true, recovery: "model" };
    case "AGENT_STEP_LIMIT":
      return { title: "Step limit reached", detail: "The agent hit the 24-step safety limit. Review what completed and narrow the next request.", retryable: false, recovery: "request" };
    case "APPROVAL_DENIED":
    case "APPROVAL_REJECTED":
    case "APPROVAL_TIMEOUT":
      return { title: "Action not approved", detail: "The requested action was not approved, so no change was made.", technicalDetail, retryable: false };
    case "RUN_ALREADY_ACTIVE":
      return { title: "Another task is running", detail: "Stop the current task before starting a new one.", retryable: false };
    default:
      return looksTechnical
        ? {
            title: "Request failed",
            detail: looksTransient
              ? "The service is temporarily unavailable. Wait a moment and try again."
              : "The request could not be completed. Try again, or review the technical details if the problem continues.",
            technicalDetail,
            retryable: looksTransient,
          }
        : { title: "Request failed", detail: technicalDetail, retryable: looksTransient };
  }
}
