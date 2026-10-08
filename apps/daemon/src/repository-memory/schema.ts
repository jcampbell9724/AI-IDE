import { z } from "zod";

export const MAX_CONTEXT_BYTES = 12_000;
export const MAX_HANDOFF_BYTES = 8_000;
export const MAX_STATE_BYTES = 2_000_000;
export const MAX_SOURCE_BYTES = 2_000_000;

const id = z.string().min(1).max(200).regex(/^[\w.:-]+$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const line = z.string().trim().min(1).max(1000);
const lines = z.array(line).max(20);
export const pathSchema = z.string().min(1).max(1000).refine((value) =>
  !value.includes("\0") && !value.includes(":") && !value.startsWith("/") &&
  !value.startsWith("\\") && !value.split(/[\\/]/).includes(".."),
"Evidence and scope paths must be relative paths within the project");
export const evidenceSchema = z.object({ path: pathSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const handoffSchema = z.object({
  objective: z.string().trim().min(1).max(2000),
  constraints: lines,
  constraintsRevisionReason: z.string().trim().min(1).max(1000).optional(),
  completed: lines,
  decisions: lines,
  blockers: lines,
  nextSteps: lines,
  validation: lines,
  evidence: z.array(evidenceSchema).max(20),
}).strict();
export const projectNoteSchema = z.object({
  id,
  kind: z.enum(["decision", "code-claim"]),
  text: z.string().trim().min(1).max(2000),
  reason: z.string().trim().min(1).max(1000),
  scopePaths: z.array(pathSchema).max(10),
  evidence: z.array(evidenceSchema).max(20),
}).strict();
export const toolInputSchema = z.discriminatedUnion("action", [
  handoffSchema.extend({ action: z.literal("save_handoff"), expectedRevision: revision }),
  projectNoteSchema.extend({
    action: z.literal("save_project_note"), expectedRevision: revision,
    supersedesId: id.optional(), supersedesRevision: revision.optional(),
  }),
]);
export const historyCheckpointSchema = z.object({
  messageCount: z.number().int().min(0).max(500), digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type HistoryCheckpoint = z.infer<typeof historyCheckpointSchema>;
const handoffRecordSchema = handoffSchema.extend({
  historyCheckpoint: historyCheckpointSchema.optional(),
  sessionId: id, revision, updatedAt: z.string(), producer: z.literal("agent"),
}).strict();
const noteRecordSchema = projectNoteSchema.extend({
  revision, updatedAt: z.string(), producer: z.literal("agent"),
  status: z.enum(["active", "superseded"]), supersededBy: id.optional(),
}).strict();
export const runSchema = z.object({
  sessionId: id, runId: id, startedAt: z.string(), updatedAt: z.string(),
  status: z.enum(["running", "finished", "interrupted"]), reason: z.string().max(1000).optional(),
  contextBytes: z.number().int().nonnegative(), estimatedContextTokens: z.number().int().nonnegative(),
  providerInputTokens: z.number().finite().nonnegative().optional(),
  providerOutputTokens: z.number().finite().nonnegative().optional(),
  providerTotalTokens: z.number().finite().nonnegative().optional(),
  handoffSaves: z.number().int().nonnegative(), noteSaves: z.number().int().nonnegative(),
}).strict();
export const stateSchema = z.object({
  version: z.literal(1), root: z.string().min(1),
  handoffs: z.array(handoffRecordSchema).max(50),
  notes: z.array(noteRecordSchema).max(100),
  runs: z.array(runSchema).max(100),
}).strict();
export const startSchema = z.object({
  sessionId: id, runId: id, objective: z.string().trim().min(1).max(2000),
  historyCheckpoint: historyCheckpointSchema.optional(),
});
export type SourceEvidence = z.infer<typeof evidenceSchema>;
export type Handoff = z.infer<typeof handoffRecordSchema>;
export type ProjectNote = z.infer<typeof noteRecordSchema>;
export type MemoryRunMetric = z.infer<typeof runSchema>;
export type MemoryState = z.infer<typeof stateSchema>;
export type MemoryToolInput = z.infer<typeof toolInputSchema>;
