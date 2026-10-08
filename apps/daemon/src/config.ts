import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DaemonConfig {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly bearerToken: string;
  readonly generatedBearerToken: boolean;
  readonly stateFile: string;
  readonly openRouterApiKey?: string;
  readonly openRouterBaseUrl: string;
  readonly openRouterReferer?: string;
  readonly openRouterTitle: string;
  readonly allowedOrigins: readonly string[];
  readonly codebaseMapEnabled: boolean;
  readonly repositoryMemoryEnabled?: boolean;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePort(value: string | undefined): number {
  if (!value) return 3210;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("BROWSER_AGENT_PORT must be an integer from 1 to 65535");
  }
  return parsed;
}

function parseBoolean(value: string | undefined, name: string): boolean {
  const normalized = optional(value)?.toLocaleLowerCase();
  if (normalized === undefined || ["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  throw new Error(`${name} must be true/false, yes/no, on/off, or 1/0`);
}

function defaultStateFile(): string {
  const base =
    optional(process.env.BROWSER_AGENT_DATA_DIR) ??
    optional(process.env.LOCALAPPDATA) ??
    optional(process.env.XDG_STATE_HOME) ??
    join(homedir(), ".local", "state");
  return join(base, "ai-browser-agent", "state.json");
}

export function readConfig(): DaemonConfig {
  const configuredToken = optional(process.env.BROWSER_AGENT_TOKEN);
  const generatedBearerToken = configuredToken === undefined;
  const bearerToken = configuredToken ?? randomBytes(32).toString("base64url");
  const openRouterApiKey = optional(process.env.OPENROUTER_API_KEY);
  const openRouterReferer =
    optional(process.env.OPENROUTER_SITE_URL) ??
    optional(process.env.OPENROUTER_HTTP_REFERER);

  return {
    host: "127.0.0.1",
    port: parsePort(process.env.BROWSER_AGENT_PORT),
    bearerToken,
    generatedBearerToken,
    stateFile: optional(process.env.BROWSER_AGENT_STATE_FILE) ?? defaultStateFile(),
    ...(openRouterApiKey === undefined ? {} : { openRouterApiKey }),
    openRouterBaseUrl:
      optional(process.env.OPENROUTER_BASE_URL) ?? "https://openrouter.ai/api/v1",
    ...(openRouterReferer === undefined ? {} : { openRouterReferer }),
    openRouterTitle:
      optional(process.env.OPENROUTER_APP_NAME) ??
      optional(process.env.OPENROUTER_APP_TITLE) ??
      "AI Browser Developer Agent",
    allowedOrigins: (optional(process.env.BROWSER_AGENT_ALLOWED_ORIGINS) ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    repositoryMemoryEnabled: parseBoolean(
      process.env.BROWSER_AGENT_REPOSITORY_MEMORY_ENABLED,
      "BROWSER_AGENT_REPOSITORY_MEMORY_ENABLED",
    ),
    codebaseMapEnabled: parseBoolean(
      process.env.BROWSER_AGENT_CODEBASE_MAP_ENABLED,
      "BROWSER_AGENT_CODEBASE_MAP_ENABLED",
    ),
  };
}
