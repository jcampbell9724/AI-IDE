export interface DiffPreviewOptions {
  readonly maxCharacters?: number;
  readonly maxLines?: number;
  readonly filePath?: string;
}

/**
 * Produces a small unified-style context diff between two file snapshots.
 * It is intentionally simple: it finds the first line-level divergence and
 * brackets the surrounding context. It is meant for human previews (approvals,
 * summaries), not for machine consumption.
 */
export function contextDiffPreview(
  before: string,
  after: string,
  options: DiffPreviewOptions = {},
): string {
  const maxCharacters = options.maxCharacters ?? 4000;
  const maxLines = options.maxLines ?? 60;
  if (before === after) return "";
  const header = options.filePath === undefined ? "" : `--- a/${options.filePath}\n+++ b/${options.filePath}`;
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const shared = Math.min(beforeLines.length, afterLines.length);

  let start = 0;
  while (start < shared && beforeLines[start] === afterLines[start]) start += 1;
  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const contextBefore = Math.min(start, 2);
  const contextAfter = 2;
  const lineStart = start - contextBefore;
  const removedCount = beforeEnd - lineStart;
  const addedCount = afterEnd - lineStart;
  const lines: string[] = [];
  if (header) lines.push(header);
  lines.push(`@@ -${lineStart + 1},${removedCount} +${lineStart + 1},${addedCount} @@`);

  for (let index = lineStart; index < start; index += 1) {
    lines.push(` ${beforeLines[index] ?? ""}`);
  }
  for (let index = start; index < beforeEnd; index += 1) {
    lines.push(`-${beforeLines[index] ?? ""}`);
  }
  for (let index = start; index < afterEnd; index += 1) {
    lines.push(`+${afterLines[index] ?? ""}`);
  }
  for (let index = beforeEnd; index < Math.min(beforeLines.length, beforeEnd + contextAfter); index += 1) {
    lines.push(` ${beforeLines[index] ?? ""}`);
  }

  let output = lines.join("\n");
  const lineCount = output.split("\n").length;
  if (output.length >= maxCharacters || lineCount > maxLines) {
    output = output.split("\n").slice(0, maxLines).join("\n");
    output += `\n… preview truncated (${maxLines} line${maxLines === 1 ? "" : "s"} / ${maxCharacters} characters)`;
  }
  return output;
}