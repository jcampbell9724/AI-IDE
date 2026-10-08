# Feature and API status

This page is the truth table for the current MVP. “Implemented” means code exists in the repository; it does not imply production hardening. “Integration” means the contract or major pieces exist but the end-to-end path still needs verification. “Deferred” means callers must not assume support.

Last reviewed: 2026-09-02.

## Feature status

| Area | Status | Current behavior / boundary |
| --- | --- | --- |
| Desktop application shell | Implemented, manual pass pending | Electron window embeds the agent runtime and a sandboxed localhost `WebContentsView`; no separate daemon, extension, port, or token is required |
| In-app configuration | Implemented | First-run provider key, project, model, approval mode, development process, browser URL, and launch preference are configured in the app |
| Conversation history | Implemented | Desktop and optional extension retain bounded, locally stored conversations with per-chat sessions, migration, switching, deletion, and interrupted-run recovery |
| Desktop credential storage | Implemented | OpenRouter key is encrypted with OS-backed Electron `safeStorage`; plaintext fallback is rejected and only configured status reaches the renderer |
| Native project selection | Implemented | Electron folder picker feeds the workspace guard and detects common manifest development commands, with an explicit override available |
| Optional codebase map | Implemented, opt-in | Off by default; lazily builds a local, bounded Python/JavaScript/TypeScript structural index and exposes one read-only agent query tool. Results are advisory and supported-file coverage is static/best effort; see [codebase-map boundaries](CODEBASE_MAP.md) |
| Desktop browser driver | Integration | Loopback navigation, context/element inspection, input, navigation, screenshot, console, and network-error actions are implemented; broader manual browser matrices remain |
| Windows installer | Implemented, unsigned | Electron Builder NSIS pipeline produces a per-user installable application; code signing and clean-machine verification remain release gates |
| Child-process secret isolation | Implemented | Project servers, shell tools, and Git commands receive a scrubbed environment without provider or legacy daemon credentials |
| Manifest V3 shell | Implemented | Chrome 125 minimum, side panel manifest, background worker, top-frame HTTP(S) content script, loopback host permissions |
| Side-panel toolbar behavior | Implemented | Toolbar click opens the side panel; per-tab enablement is limited to ordinary HTTP(S) URLs |
| Side-panel application UI | Implemented, manual pass pending | Guided readiness checklist, compact context header, semantic keyboard tabs, gated chat, persistent conversation history, readable tool activity, locked approvals, model/project flows, persistent preview state, and actionable errors; unpacked-Chrome appearance still needs a local visual pass after each build |
| Element picker | Implemented | Hover/select overlay, compact context capture, multiple selections, removal/clear; top frame only |
| Stable selector generation | Implemented, best effort | Desktop and extension paths share uniqueness-checked selectors that prefer stable IDs/test attributes and ancestors before positional fallbacks; selectors may still become stale after navigation or rerender |
| Temporary visual edits | Implemented | Allowlists preview editing commands with undo, redo, delta reporting, and discard |
| DOM-to-source persistence | Deferred | The MVP does not guarantee mapping a selected DOM node or temporary CSS override back to source |
| Debugger browser broker | Integration | Explicit browser-action/CDP adapter exists; full navigation/frame/detach matrix still requires manual verification |
| Project discovery | Implemented | Suggests the daemon startup folder and recent projects, then detects common manifests, runtimes, frameworks, package manager, scripts, and commands after confirmation |
| Workspace containment | Implemented | Canonical root, traversal rejection, and symlink/ancestor containment checks |
| Filesystem tools | Implemented | Bounded list/read/search/write/replace, generated-directory skips, atomic overwrite |
| Git inspection | Implemented | Status, diff, and log are scoped to the selected workspace |
| Dev-process control | Implemented | One process with start/stop/restart, bounded logs, and explicit state |
| Structured commands | Implemented | Command + argument execution, timeout/output bounds, rejection of compound/redirection syntax |
| Approval manager | Implemented | `ask`, `auto-safe`, and `deny`; pending approvals time out and cancel with their run |
| OpenRouter model discovery | Integration | Model schema/client path is defined; live behavior requires a valid key and network verification |
| Tool-capable model filtering | Implemented | Discovery requests `supported_parameters=tools`, normalizes capabilities, and selects a compatible default; live availability remains provider-dependent |
| Agent tool loop | Implemented | Bounded, serialized tool calls retain assistant/tool messages, reject empty model completions, and are covered by deterministic runner tests; a live provider pass remains manual |
| Agent event streaming | Integration | Extension expects Server-Sent Events; reconnect/resume is not promised |
| Cancellation | Integration | Run IDs and cancellation contract exist; confirm pending OpenRouter and tool work aborts in manual tests |
| Secret redaction / DLP | Deferred | Users must avoid selecting or submitting sensitive data |
| Cross-origin iframe picker | Deferred | Manifest injects the content script into the top frame only |
| Closed shadow-root support | Deferred | Not inspectable by the ordinary content-script picker |
| Native Messaging | Deferred | Loopback HTTP + bearer authentication is the MVP transport |
| GitHub integration / MCP | Deferred | No OAuth, issue, branch, PR, or GitHub MCP workflow is promised |
| Multi-user / remote daemon | Out of scope | Daemon must remain on loopback; no tenant isolation |
| Demo page | Implemented | Responsive Vite page on port 4173 with stable IDs/classes/test IDs and local form/menu interactions |

## Daemon HTTP contract

The extension client currently targets the routes below. Treat them as MVP-internal and versioned only by the `/v1` prefix; backwards compatibility is not yet guaranteed.

| Method and route | Auth | Purpose | Status |
| --- | --- | --- | --- |
| `GET /health` | None | Local reachability without secrets | Integration |
| `GET /v1/models` | Bearer | Return normalized OpenRouter models; optional `?refresh=1` | Integration |
| `GET /v1/project` | Bearer | Current/recent project state | Integration |
| `POST /v1/project/select` | Bearer | Select and detect a local project | Integration |
| `POST /v1/project/start` | Bearer | Start configured project process | Integration |
| `POST /v1/project/stop` | Bearer | Stop the current process tree | Integration |
| `POST /v1/project/restart` | Bearer | Restart the current process | Integration |
| `GET /v1/project/logs?after=<seq>` | Bearer | Poll bounded logs after a sequence number | Integration |
| `POST /v1/agent/run` | Bearer | Start a run and stream typed SSE events | Integration |
| `POST /v1/agent/cancel` | Bearer | Cancel by `runId` | Integration |
| `POST /v1/approvals/:id` | Bearer | Approve or reject a pending mutation | Integration |
| `POST /v1/browser/results/:id` | Bearer | Resolve a pending browser request | Integration |

Expected errors use:

```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Human-readable explanation"
  }
}
```

Do not build external clients against this table until the server integration and contract tests pass.

## Shared tool surface

| Tool | Mutation class | Approval expectation |
| --- | --- | --- |
| `fs_list`, `fs_read`, `fs_search` | Read-only workspace access | No mutation approval; still schema/path guarded |
| `git_status`, `git_diff`, `git_log` | Read-only Git inspection | No mutation approval |
| `fs_write`, `fs_replace` | Workspace write | Required in `ask`; blocked in `deny` |
| `shell_run` | Host process | Required in `ask` and `auto-safe`; blocked in `deny` |
| `browser` read actions | Tab inspection | Policy-dependent; sensitive output still visible to model |
| `browser` side effects | Navigation/input/click etc. | Required in `ask` and `auto-safe`; blocked in `deny` |
| `codebase_map` (when enabled) | Read-only project indexing/query | No mutation approval; tool results are sent to the selected model and must be verified against current source |

The allowed browser action vocabulary is: `context`, `inspect_element`, `navigate`, `back`, `forward`, `refresh`, `tabs`, `click`, `type`, `key`, `scroll`, `hover`, `focus`, `wait_for`, `screenshot`, `console`, and `network_errors`. Browser context returns a tab id that later actions can reuse to prevent active-tab drift. The broker, not the model, decides which implementation and Chrome API each value can reach.

## OpenRouter API expectations

- Model discovery: `GET https://openrouter.ai/api/v1/models?supported_parameters=tools` with bearer authentication. Model IDs and capabilities are dynamic; do not hardcode a catalog. See [Models API guidance](https://openrouter.ai/docs/guides/overview/models).
- Chat/tool calls: `POST https://openrouter.ai/api/v1/chat/completions`, using the selected model and a complete `tools` array on every loop turn. See the [quickstart](https://openrouter.ai/docs/quickstart) and [tool-calling guide](https://openrouter.ai/docs/guides/features/tool-calling).
- Each assistant `tool_calls` entry must be followed by a `role: "tool"` message whose `tool_call_id` matches.
- The MVP should set `parallel_tool_calls: false`, use `stream: false` upstream, validate arguments locally, and enforce a bounded tool-turn count. The daemon may still stream its own typed SSE events downstream.
- Treat both non-2xx responses and nominal completion choices whose finish reason reports an error as failures. Preserve provider diagnostics without leaking credentials; see [OpenRouter errors and debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging).
- Tool schemas should remain compatible with JSON Schema Draft 7 for broad provider routing. OpenRouter's [Auto Exacto](https://openrouter.ai/docs/guides/routing/auto-exacto) documents schema normalization and provider selection.

## Definition of desktop release-ready

The desktop build should not be called generally available until all of the following pass:

1. A clean Windows machine can install, launch, configure, update, and uninstall the signed application without Node or pnpm.
2. OS-backed encryption is available, no credential appears in renderer state/logs/project environments, and corrupt settings fail recoverably.
3. Native project selection, detection, start/stop, browser loading, one read tool, one approved write, rejection, cancellation, and clean shutdown pass end to end.
4. Installer and application binaries are code-signed and release artifacts have checksums and provenance.
5. macOS/Linux support is either tested and packaged or explicitly excluded from that release.

## Definition of legacy extension MVP-complete

The status may move from Integration to Implemented only after all of the following pass in a clean clone:

1. `pnpm install`, `pnpm check`, and an unpacked Chrome load succeed.
2. The daemon starts on loopback, rejects missing/wrong bearer tokens, and reveals no key.
3. Live tool-capable model discovery succeeds with a valid OpenRouter key.
4. A chat response streams to the panel, one read tool completes, and cancellation stops an active run.
5. A write and a command both pause for approval, rejection causes no mutation, and approval produces a reviewable result.
6. The demo picker captures stable context; a preview edit can be undone, redone, and discarded.
7. A debugger detach, navigation, protected page, and unsupported frame fail visibly and safely.
8. The full [Manual smoke test](SMOKE_TEST.md) is recorded with browser and Node versions.
