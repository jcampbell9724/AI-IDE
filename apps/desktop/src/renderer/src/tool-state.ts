import type { AgentEvent } from "@browser-agent/shared";
import type { PersistedTool } from "./persist";

export function applyToolEvent(current: PersistedTool[], event: AgentEvent): PersistedTool[] {
  switch (event.type) {
    case "tool.started":
      return [{ id: event.toolCallId, name: event.name, status: "running" }];
    case "tool.finished":
      return [{
        id: event.toolCallId,
        name: event.name,
        status: event.error ? "failed" : "done",
        ...(event.error === undefined ? {} : { summary: event.error }),
      }];
    case "approval.required":
      return [{
        id: event.approvalId,
        approvalId: event.approvalId,
        name: event.kind,
        status: "approval",
        summary: event.summary,
      }];
    case "approval.resolved":
      return current.map((tool) => tool.approvalId === event.approvalId
        ? { ...tool, status: event.decision === "approve" ? "done" : "failed" }
        : tool);
    default:
      return current;
  }
}

export function settlePendingTools(tools: readonly PersistedTool[], summary: string): PersistedTool[] {
  return tools.map((tool) => {
    if (tool.status !== "running" && tool.status !== "approval") return tool;
    const { approvalId: _approvalId, ...settled } = tool;
    return { ...settled, status: "failed", summary };
  });
}
