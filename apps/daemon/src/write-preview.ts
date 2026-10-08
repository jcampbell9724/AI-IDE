import { contextDiffPreview } from "./diff-preview.js";

/**
 * Builds the `details` payload attached to a write approval request so the UI
 * can show the user what would change (a unified-style diff) instead of a bare
 * path and operation string.
 */

const MAX_PAYLOAD_CHARS = 1200;

function boundedText(value: string): string {
  if (value.length <= MAX_PAYLOAD_CHARS) return value;
  return `${value.slice(0, MAX_PAYLOAD_CHARS)}\n… (${value.length - MAX_PAYLOAD_CHARS} more characters)`;
}

export interface WriteApprovalDetailsInput {
  /** Workspace-relative path the model requested. */
  readonly path: string;
  readonly operation: "fs_replace" | "fs_write";
  /** Current file contents, or null when the file does not exist. */
  readonly before: string | null;
  readonly fsReplace?: {
    readonly oldText: string;
    readonly newText: string;
  };
  readonly fsWrite?: {
    readonly content: string;
    readonly overwrite: boolean;
  };
}

export interface WriteApprovalDetails {
  readonly [key: string]: unknown;
  readonly path: string;
  readonly operation: "fs_replace" | "fs_write";
  readonly mode: "replace" | "create" | "overwrite" | "create-exclusive";
  readonly oldText?: string;
  readonly newText?: string;
  readonly preview?: string;
}

export function buildWriteApprovalDetails(
  input: WriteApprovalDetailsInput,
): WriteApprovalDetails {
  const mode = input.operation === "fs_write" && input.fsWrite
    ? input.before === null
      ? "create"
      : input.fsWrite.overwrite
        ? "overwrite"
        : "create-exclusive"
    : "replace";
  const details: WriteApprovalDetails = {
    path: input.path,
    operation: input.operation,
    mode,
    ...(input.fsReplace
      ? {
          oldText: boundedText(input.fsReplace.oldText),
          newText: boundedText(input.fsReplace.newText),
        }
      : {}),
  };

  if (input.before !== null) {
    const after =
      input.operation === "fs_replace" && input.fsReplace
        ? input.before.split(input.fsReplace.oldText).join(input.fsReplace.newText)
        : input.fsWrite?.content ?? input.before;
    const preview = contextDiffPreview(input.before, after, { filePath: input.path });
    if (preview) return { ...details, preview };
  }
  return details;
}
