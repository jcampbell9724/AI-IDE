# Span — AI development workspace

Span is a Windows desktop coding-agent prototype that puts project files, AI chat, development processes, and a localhost browser in one workspace. Its emphasis is on reviewable tool execution and persistent project context.

**Status:** active prototype. The source builds and the automated checks pass in the reviewed snapshot. Live provider sessions, installer behavior on a clean machine, and release signing still require verification.

## What the prototype demonstrates

- An Electron/React interface connected to an embedded TypeScript agent runtime.
- A bounded model/tool loop with streamed responses, typed tool arguments, cancellation, and explicit approvals for consequential actions.
- Workspace-scoped file inspection and editing, Git inspection, and project process controls.
- An isolated localhost browser with element inspection, navigation, screenshots, and browser actions.
- Optional structural codebase mapping for Python, JavaScript, and TypeScript using Tree-sitter WASM.
- Optional repository memory with compact handoffs, source-hash evidence, revision checks, checkpoint enforcement, and run reports.

The agent loop executes tool calls serially, with a maximum of 24 model turns. This repository demonstrates an agent harness; it does not implement a multi-agent scheduler.

## Architecture

```text
React desktop interface
        │ validated IPC
        ▼
Electron main process
  ├─ encrypted provider settings
  ├─ embedded agent runtime ── model provider
  │    ├─ approvals and cancellation
  │    ├─ guarded file / Git / process tools
  │    ├─ optional structural map
  │    └─ optional repository memory
  └─ sandboxed localhost WebContentsView
```

The desktop renderer does not receive saved credentials. The embedded browser disables Node integration, enables context isolation and Chromium sandboxing, and restricts navigation to loopback HTTP(S). Project commands receive an environment that removes `OPENROUTER_API_KEY` and `BROWSER_AGENT_TOKEN`. Other inherited environment secrets are not covered by that filter. Approved commands still run with the user's operating-system permissions; this application is not an operating-system sandbox.

## Provider support

| Path | State in the reviewed snapshot |
| --- | --- |
| OpenRouter | Primary integration; dynamic tool-capable model discovery, streamed responses, and tool exchanges have automated coverage |
| Direct OpenAI | Client-level streaming path has mocked test coverage; it is not wired into the desktop UI/runtime provider selection, and live behavior is unverified |
| Direct Anthropic | Incomplete client/settings scaffolding; the review copy returns an explicit unsupported-provider error before a direct chat request. Anthropic models can instead be selected through OpenRouter when available |

Automated tests use deterministic provider responses. They establish runtime behavior without proving current provider availability or model quality.

## Run from source

Use Node.js 22.12+ and the pnpm version pinned in `package.json`.

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm dev:desktop
```

In the application, connect OpenRouter, select a project, choose a tool-capable model, and open the project's localhost preview. The selected project needs its own dependencies and language runtime.

The review used Node.js 24.19.0 and pnpm 11.25.0, with dependency lifecycle scripts disabled during installation. That review verified source builds, not an installed or running Electron application.

## Repository layout

| Directory | Responsibility |
| --- | --- |
| `apps/desktop` | Electron main/preload processes, React interface, native browser driver, settings, and installer configuration |
| `apps/daemon` | Embedded agent services plus an optional legacy loopback HTTP adapter |
| `apps/extension` | Optional Chrome side-panel client and browser-action broker |
| `packages/shared` | Zod runtime schemas and shared TypeScript contracts |
| `examples/demo-app` | Local Vite fixture for browser smoke tests |

## Codebase mapping and memory

Both features are off by default and have independent controls.

The codebase map is a local structural graph of symbols, imports, references, calls, test relationships, and source ranges. It incrementally reuses content hashes and reports incomplete results. Its `semantic_context` action explicitly reports that automatic semantic enrichment is disabled. This is not embedding-based retrieval or a benchmarked semantic search system.

Repository memory saves task handoffs and project notes, verifies source evidence against live hashes, and applies bounded checkpoint rules in the agent runner. Run reports distinguish complete, partial, and unavailable provider usage. No token-savings or task-quality benchmark has been established.

Although indexing and memory persistence are local, selected tool results and restored context are sent to the configured model provider during an agent run. Sensitive-data redaction is not implemented.

## Verification

In the isolated October 7, 2026 review copy, `pnpm check` passed after replacing a call to an absent direct-Anthropic method with the explicit unsupported-provider error and adding a regression test:

- Type checks passed across all workspaces.
- 564 automated tests passed across 72 test files.
- Shared, daemon, extension, desktop, and demo source builds passed.

Tests cover tool/result correlation, approvals, workspace containment, process credential isolation, streamed response parsing, cancellation, structural indexing, memory checkpoints, and desktop state/recovery helpers. Most desktop tests exercise helpers and contracts; they are not a full interactive Electron test matrix.

## Current limits

- Windows installer configuration exists, but this review did not build an installer, verify clean-machine installation, or establish code signing.
- Live provider execution and the full manual browser workflow remain unverified in this review.
- DOM selection and temporary CSS previews do not guarantee a persisted source-code change.
- Commands are approved host processes, not container-isolated execution.
- Multi-user hosting, GitHub/MCP integration, remote execution, and a multi-agent scheduler are not implemented.
- Mapping and memory have no measured token-efficiency or task-quality results.

See [architecture](docs/ARCHITECTURE.md), [codebase mapping](docs/CODEBASE_MAP.md), [repository memory](docs/REPOSITORY_MEMORY.md), [manual smoke test](docs/SMOKE_TEST.md), and [security boundaries](SECURITY.md).
