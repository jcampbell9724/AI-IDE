export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const GENERIC_MESSAGES = new Set(["fetch failed", "Error", ""]);

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const message = error.message || error.name || "Unknown error";
  if (!GENERIC_MESSAGES.has(message)) return message;
  const cause = unwrapCause(error);
  return cause ? `${message}: ${cause}` : message;
}

function unwrapCause(error: Error, depth = 0): string | undefined {
  if (depth >= 5) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (cause === undefined) return undefined;
  if (Array.isArray(cause)) {
    for (const entry of cause) {
      const detail = causeDetail(entry, depth);
      if (detail) return detail;
    }
    return undefined;
  }
  return causeDetail(cause, depth);
}

function causeDetail(value: unknown, depth: number): string | undefined {
  if (value instanceof AggregateError) {
    for (const entry of value.errors) {
      const detail = causeDetail(entry, depth + 1);
      if (detail) return detail;
    }
    return undefined;
  }
  if (value instanceof Error) {
    if (value.message && !GENERIC_MESSAGES.has(value.message)) {
      return value.message;
    }
    return unwrapCause(value, depth + 1);
  }
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  const text = String(value).trim();
  return text && text !== "undefined" && text !== "null" ? text : undefined;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Operation cancelled", "AbortError");
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
