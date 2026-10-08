import type { ReactElement } from "react";
import type { PreviewStartupState } from "../../shared/contracts";

export function previewStatusLabel(state: PreviewStartupState | undefined): string | null {
  switch (state?.phase) {
    case "starting": return "Starting project…";
    case "waiting": return "Waiting for preview…";
    case "ready": return "Preview ready";
    case "needs-url": return "Enter a preview URL";
    case "failed": return "Preview needs attention";
    default: return null;
  }
}

export function previewShowsStatus(state: PreviewStartupState | undefined): boolean {
  return Boolean(state && !["idle", "ready"].includes(state.phase));
}

export function PreviewStatus({ state, onLogs, onRetry, retryLabel, onEditCommand, editCommandLabel, onSetUrl, busy }: {
  state: PreviewStartupState;
  onLogs?: () => void;
  onRetry?: () => void;
  retryLabel?: string;
  onEditCommand?: () => void;
  editCommandLabel?: string;
  onSetUrl?: () => void;
  busy?: boolean;
}): ReactElement {
  const detail = state.phase === "starting" ? "Launching your project's development server."
    : state.phase === "waiting" ? "The server is warming up. Your preview will open automatically when it responds. You can still stop or restart the project."
      : state.phase === "needs-url" ? "The project has started. Enter its localhost URL above and choose Open."
        : state.message;
  return <div className="browser-empty preview-startup" role={state.phase === "failed" ? "alert" : "status"}>
    <h3>{previewStatusLabel(state)}</h3>
    <p>{detail}</p>
    {state.url && <small>{state.url}</small>}
    <div className="preview-recovery-actions">
      {state.phase === "needs-url" && onSetUrl && <button className="button primary" type="button" onClick={onSetUrl} disabled={busy}>Set preview URL</button>}
      {state.phase === "failed" && onRetry && <button className="button primary" type="button" onClick={onRetry} disabled={busy}>{retryLabel ?? "Retry preview"}</button>}
      {onLogs && <button className="button ghost" type="button" onClick={onLogs}>View logs</button>}
      {state.phase === "failed" && onEditCommand && <button className="button ghost" type="button" onClick={onEditCommand} disabled={busy}>{editCommandLabel ?? "Edit run command"}</button>}
    </div>
  </div>;
}
