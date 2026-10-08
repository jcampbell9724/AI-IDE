import { RunDiagnosticsSchema, type AgentEvent, type RunDiagnostics } from "@browser-agent/shared";
import { z } from "zod";
import type { StorageLike } from "../persist";

export const RUN_REPORT_LIMIT = 20;
export const RUN_REPORT_KEY_PREFIX = "span.project-run-reports.v1";
const MAX_STORED_CHARACTERS = 400_000;
const ReportSchema = z.object({
  runId: z.string().min(1).max(200),
  timestamp: z.iso.datetime({ offset: true }),
  outcome: z.enum(["completed", "error", "cancelled"]),
  diagnostics: RunDiagnosticsSchema,
});

export interface RunReport {
  runId: string;
  timestamp: string;
  outcome: "completed" | "error" | "cancelled";
  diagnostics: RunDiagnostics;
}

export function reportFromEvent(event: AgentEvent): RunReport | null {
  if (event.type !== "run.completed" && event.type !== "run.error" && event.type !== "run.cancelled") return null;
  const parsed = ReportSchema.safeParse({
    runId: event.runId,
    timestamp: event.timestamp,
    outcome: event.type.slice(4),
    diagnostics: event.diagnostics,
  });
  return parsed.success ? parsed.data : null;
}

export function loadRunReports(projectPath: string | null, storage: StorageLike | null = rendererStorage()): RunReport[] {
  if (!projectPath || !storage) return [];
  try {
    const serialized = storage.getItem(projectKey(projectPath));
    if (!serialized || serialized.length > MAX_STORED_CHARACTERS) return [];
    const stored: unknown = JSON.parse(serialized);
    if (!stored || typeof stored !== "object" || !("version" in stored) || stored.version !== 1 || !("reports" in stored)) return [];
    return sanitizeReports(stored.reports);
  } catch { return []; }
}

// Validate and strip unknown fields on both writes and exports. Reports never retain
// entire events: those may contain source, prompts, tool output, or error text.
export function saveRunReports(projectPath: string | null, reports: readonly RunReport[], storage: StorageLike | null = rendererStorage()): boolean {
  if (!projectPath || !storage) return false;
  try {
    const clean = sanitizeReports(reports);
    if (clean.length) storage.setItem(projectKey(projectPath), JSON.stringify({ version: 1, reports: clean }));
    else storage.removeItem(projectKey(projectPath));
    return true;
  } catch { return false; }
}

export function prependRunReport(reports: readonly RunReport[], report: RunReport): RunReport[] {
  return sanitizeReports([report, ...reports]);
}

export function exportRunReports(reports: readonly RunReport[]): string {
  return JSON.stringify({ version: 1, reports: sanitizeReports(reports) }, null, 2);
}

function sanitizeReports(value: unknown): RunReport[] {
  if (!Array.isArray(value)) return [];
  const reports: RunReport[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, RUN_REPORT_LIMIT * 2)) {
    const parsed = ReportSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.runId)) continue;
    seen.add(parsed.data.runId);
    reports.push(parsed.data);
    if (reports.length === RUN_REPORT_LIMIT) break;
  }
  return reports;
}

function projectKey(projectPath: string): string {
  const normalized = projectPath.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  const windowsPath = /^[a-z]:\//i.test(normalized) || normalized.startsWith("//");
  return `${RUN_REPORT_KEY_PREFIX}:${encodeURIComponent(windowsPath ? normalized.toLowerCase() : normalized)}`;
}

function rendererStorage(): StorageLike | null {
  try { return window.localStorage; } catch { return null; }
}
