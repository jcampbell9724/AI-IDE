import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  ApprovalKind,
  ApprovalMode,
} from "@browser-agent/shared";
import { AppError, throwIfAborted } from "./errors.js";

export interface ApprovalRequestInput {
  readonly runId: string;
  readonly kind: ApprovalKind;
  readonly summary: string;
  readonly details: Record<string, unknown>;
  readonly mode: ApprovalMode;
  readonly emit: (event: AgentEvent) => void;
  readonly signal?: AbortSignal;
}

interface PendingApproval {
  readonly id: string;
  readonly input: ApprovalRequestInput;
  readonly resolve: (approved: boolean) => void;
  readonly reject: (error: unknown) => void;
  readonly timeout: NodeJS.Timeout;
  readonly onAbort?: () => void;
}

export class ApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();

  async require(input: ApprovalRequestInput): Promise<void> {
    throwIfAborted(input.signal);
    if (input.mode === "deny") {
      throw new AppError("APPROVAL_DENIED", `${input.kind} actions are disabled`, 403);
    }
    if (input.mode === "auto-safe" && input.kind === "write") return;

    const id = randomUUID();
    input.emit({
      type: "approval.required",
      runId: input.runId,
      timestamp: new Date().toISOString(),
      approvalId: id,
      kind: input.kind,
      summary: input.summary,
      details: input.details,
    });

    const approved = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError("APPROVAL_TIMEOUT", "Approval request timed out", 408));
      }, 10 * 60_000);
      timeout.unref();
      const onAbort = input.signal
        ? () => {
            this.pending.delete(id);
            clearTimeout(timeout);
            reject(new DOMException("Operation cancelled", "AbortError"));
          }
        : undefined;
      if (onAbort) input.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { id, input, resolve, reject, timeout, ...(onAbort ? { onAbort } : {}) });
    });

    if (!approved) {
      throw new AppError("APPROVAL_REJECTED", "The user rejected the action", 403);
    }
  }

  decide(id: string, decision: "approve" | "reject"): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.onAbort) {
      pending.input.signal?.removeEventListener("abort", pending.onAbort);
    }
    pending.input.emit({
      type: "approval.resolved",
      runId: pending.input.runId,
      timestamp: new Date().toISOString(),
      approvalId: id,
      decision,
    });
    pending.resolve(decision === "approve");
    return true;
  }

  cancelRun(runId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.input.runId !== runId) continue;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(new DOMException("Operation cancelled", "AbortError"));
    }
  }
}
