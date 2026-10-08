import type { ChangeEvent, ReactElement } from "react";
import "./codebase-map.css";

export interface CodebaseMapSettingsProps {
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly onChange: (enabled: boolean) => void;
  readonly repositoryMemoryEnabled: boolean;
  readonly onRepositoryMemoryChange: (enabled: boolean) => void;
}

/**
 * The optional repository context preferences, kept together in Span settings.
 */
export function CodebaseMapSettings(props: CodebaseMapSettingsProps): ReactElement {
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    props.onChange(event.target.checked);
  };

  return <div
    id="settings-panel-settings"
    className="settings-group settings-tab-panel codebase-map-settings"
    role="tabpanel"
    aria-labelledby="settings-tab-settings"
    tabIndex={0}
  >
    <div className="settings-label">
      <div>
        <strong>Persistent codebase map</strong>
        <small id="codebase-map-description">
          Builds a compact structural index for faster symbol lookup, impact tracing, and test discovery.
        </small>
      </div>
      <span className={props.enabled ? "configured" : "optional"}>{props.enabled ? "On" : "Off"}</span>
    </div>

    <label className="codebase-map-toggle">
      <span>
        <strong>Use codebase mapping</strong>
        <small>The index starts lazily when the agent first uses it and stays in local app data.</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={props.enabled}
        disabled={props.busy}
        aria-describedby="codebase-map-description"
        onChange={handleChange}
      />
      <span className="codebase-map-toggle-track" aria-hidden="true"><span /></span>
    </label>

    <p className="codebase-map-boundary">
      The map is navigation evidence, not a replacement for reading source. Turning it off removes its agent tool but retains the rebuildable local cache.
    </p>
    <section className="repository-memory-settings" aria-labelledby="repository-memory-heading">
      <div className="settings-label">
        <div>
          <strong id="repository-memory-heading">Repository memory</strong>
          <small id="repository-memory-description">
            Saves task handoffs and project decisions so the agent can restore useful context when work continues.
          </small>
        </div>
        <span className={props.repositoryMemoryEnabled ? "configured" : "optional"}>
          {props.repositoryMemoryEnabled ? "On" : "Off"}
        </span>
      </div>

      <label className="codebase-map-toggle">
        <span>
          <strong>Use repository memory</strong>
          <small>The agent saves a checkpoint before completing a task. Memory stays in local app data.</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={props.repositoryMemoryEnabled}
          disabled={props.busy}
          aria-describedby="repository-memory-description repository-memory-boundary"
          onChange={(event) => props.onRepositoryMemoryChange(event.target.checked)}
        />
        <span className="codebase-map-toggle-track" aria-hidden="true"><span /></span>
      </label>

      <p id="repository-memory-boundary" className="codebase-map-boundary">
        Your selected agent writes the handoffs; there are no separate AI summary calls. Turning it off stops new memory reads and saves and keeps saved memory for later. Codebase mapping is controlled separately.
      </p>
    </section>
  </div>;
}
