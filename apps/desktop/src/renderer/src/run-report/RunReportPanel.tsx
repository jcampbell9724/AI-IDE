import { useEffect, useId, useState, type ReactElement, type ReactNode } from "react";
import { CopyButton } from "../copy-button";
import { formatRunDuration } from "../run-progress";
import { exportRunReports, RUN_REPORT_LIMIT, type RunReport } from "./store";
import "./run-report.css";

export function RunReportPanel(props: {
  reports: readonly RunReport[];
  storageWarning?: boolean;
  onDelete: (runId: string) => void;
  onClear: () => void;
}): ReactElement | null {
  const [selectedId, setSelectedId] = useState(props.reports[0]?.runId ?? "");
  const selectId = useId();
  useEffect(() => { setSelectedId(props.reports[0]?.runId ?? ""); }, [props.reports[0]?.runId]);
  const report = props.reports.find((item) => item.runId === selectedId) ?? props.reports[0];
  if (!report) return props.storageWarning
    ? <p className="run-report-warning" role="status">Run reports could not be saved in local storage.</p>
    : null;
  const d = report.diagnostics;
  const usageLabel = d.usage.coverage === "complete" ? "Complete" : d.usage.coverage === "partial" ? "Partial" : "Unavailable";
  return <details className="run-report">
    <summary>Run report <span>{props.reports.length} recent {props.reports.length === 1 ? "run" : "runs"}</span></summary>
    <div className="run-report-content">
      <label htmlFor={selectId}>Recent run</label>
      <select id={selectId} value={report.runId} onChange={(event) => setSelectedId(event.target.value)}>
        {props.reports.map((item) => <option key={item.runId} value={item.runId}>
          {new Date(item.timestamp).toLocaleString()} · {outcomeLabel(item.outcome)} · {item.diagnostics.requestedModel}
        </option>)}
      </select>
      <dl className="run-report-metrics">
        <Metric label="Outcome">{outcomeLabel(report.outcome)}</Metric>
        <Metric label="Duration">{formatRunDuration(d.durationMs)}</Metric>
        <Metric label="Requested model">{d.requestedModel}</Metric>
        <Metric label="Repository memory">{d.memoryEnabled ? "On" : "Off"}</Metric>
        <Metric label="Codebase map">{d.mapEnabled ? "On" : "Off"}</Metric>
        <Metric label="Model requests / responses">{d.modelRequests} / {d.modelResponses}</Metric>
        <Metric label="Provider usage">{usageLabel} ({d.usage.responsesWithUsage} of {d.modelRequests} requests with usage)</Metric>
        <Metric label="Reported input tokens">{numberOrUnavailable(d.usage.promptTokens)}</Metric>
        <Metric label="Reported output tokens">{numberOrUnavailable(d.usage.completionTokens)}</Metric>
        <Metric label="Total tokens">{numberOrUnavailable(d.usage.totalTokens)}</Metric>
        <Metric label="Reported cost (USD)">{d.usage.costUsd === undefined ? "Unavailable" : `$${d.usage.costUsd.toFixed(6)}`}</Metric>
        <Metric label="Restored context">{d.context.restoredBytes.toLocaleString()} bytes</Metric>
        <Metric label="Saved handoff resumed">{d.context.resumedHandoff ? "Yes" : "No"}</Metric>
        <Metric label="Omitted reply text">{d.context.omittedHistoryBytes.toLocaleString()} bytes / {d.context.omittedHistoryMessages} messages</Metric>
        <Metric label="Tool attempts / succeeded / failed">{d.tools.attempted} / {d.tools.succeeded} / {d.tools.failed}</Metric>
        <Metric label="Map attempts / succeeded">{d.tools.mapAttempts} / {d.tools.mapSucceeded}</Metric>
        <Metric label="Source reads / repeated reads">{d.tools.sourceReads} / {d.tools.repeatedSourceReads}</Metric>
        <Metric label="Stale / unread edit rejections">{d.tools.staleEditRejections} / {d.tools.unreadEditRejections}</Metric>
        <Metric label="Handoff saves / note saves">{d.memory.handoffSaves} / {d.memory.noteSaves}</Metric>
        <Metric label="Checkpoint reminders / blocked tools">{d.memory.checkpointReminders} / {d.memory.checkpointBlockedTools}</Metric>
        <Metric label="Checkpoint interval">{d.checkpointInterval} successful operations</Metric>
      </dl>
      {d.settingsChanged && <p className="run-report-warning">Memory or map settings changed during this run. Compare it separately from runs with fixed settings.</p>}
      {d.usage.coverage !== "complete" && <p>Provider usage is {usageLabel.toLowerCase()}. Missing token counts and cost are unavailable, and reported values may not cover the whole run.</p>}
      <p>Omitted reply text measures context reduction, not token savings. Read counts cover the file-read tool; searches and commands are excluded. Repeated reads can be necessary. Compare outcomes and provider usage across matched tasks.</p>
      <p>Last {RUN_REPORT_LIMIT} reports for this project, stored locally. Copies contain counts and run metadata; prompts, source, error text, and project paths are excluded.</p>
      {props.storageWarning && <p className="run-report-warning" role="status">Run reports could not be saved. Copy them before closing Span.</p>}
      <div className="run-report-actions">
        <CopyButton key={`report-${report.runId}`} text={exportRunReports([report])} label="Copy report" />
        <CopyButton text={exportRunReports(props.reports)} label="Copy reports" />
        <button type="button" onClick={() => props.onDelete(report.runId)}>Delete report</button>
        <button type="button" onClick={props.onClear}>Clear reports</button>
      </div>
    </div>
  </details>;
}

function Metric(props: { label: string; children: ReactNode }): ReactElement {
  return <div><dt>{props.label}</dt><dd>{props.children}</dd></div>;
}

function numberOrUnavailable(value: number | undefined): string {
  return value === undefined ? "Unavailable" : value.toLocaleString();
}

function outcomeLabel(outcome: RunReport["outcome"]): string {
  return outcome === "completed" ? "Completed" : outcome === "cancelled" ? "Stopped" : "Failed";
}
