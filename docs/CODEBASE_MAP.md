# Optional codebase map

Span includes an optional structural index for navigating supported source files. It is **off by default** and is deliberately isolated from the ordinary filesystem, Git, command, and browser tools.

The map is navigation evidence, not source authority. It can point the agent to likely definitions, relationships, affected symbols, and tests, but the agent must still read the current source before making a consequential edit.

[Repository memory](REPOSITORY_MEMORY.md) separately preserves task handoffs and project decisions, with checkpoints enforced by Span's agent runner. Its independent switch is alongside the map in Settings → Preferences; enabling either feature does not enable the other.

## Turn it on or off

In the desktop app, open **Settings**, choose the **Preferences** tab, and switch **Use codebase mapping** on or off. The choice is stored with the app's non-secret preferences.

- When off, new agent runs do not receive the `codebase_map` tool. No first-time index is built.
- When on, indexing begins lazily when an agent first queries the map. Enabling it does not scan every selected project in advance.
- A run keeps the setting it started with, so changing the switch cannot remove a tool halfway through an active tool exchange. The new setting applies to later runs.
- Turning the feature off retains its rebuildable local cache. It does not delete or modify project files.

For the optional legacy daemon, set `BROWSER_AGENT_CODEBASE_MAP_ENABLED=true` before startup. False-like values (`false`, `no`, `off`, or `0`) leave it disabled; true-like values (`true`, `yes`, `on`, or `1`) enable it. Restart the legacy daemon after changing the environment value.

## What it does

On a query, the feature discovers supported files inside the selected workspace, parses them with local Tree-sitter WASM grammars, and records a bounded graph of:

- modules, classes, interfaces, functions, methods, type aliases, variables, enums, and tests;
- containment, imports, calls, references, inheritance, implementations, and test relationships;
- stable symbol IDs, source ranges, content hashes, evidence classes, confidence values, unresolved targets, and parser diagnostics.

Unchanged files are reused by content hash. A refresh reparses changed files, resolves relationships across the complete current snapshot, records symbol changes from the preceding map snapshot, and writes the replacement cache atomically. It refuses to publish a scan when its discovery view changes while the scan is running.

Agent file writes, replacements, and shell commands invalidate the in-memory freshness check. External changes are checked when the next query's short validation interval expires. The explicit refresh remains incremental; parser-version changes automatically force affected cached files to be rebuilt without exposing an unrestricted full-reparse option to the model.

## Tool actions

The feature exposes one model-facing tool, `codebase_map`, with bounded actions:

| Action | Result |
| --- | --- |
| `project_overview` | Counts by language, symbol kind, and relationship kind, plus highly connected symbols and diagnostic totals |
| `find_symbol` | Ranked symbol matches, optionally filtered by symbol kind |
| `trace_symbol` | Incoming, outgoing, or bidirectional relationships around one unambiguous symbol |
| `impact_analysis` | Static upstream dependants that may be affected by changing a symbol |
| `related_tests` | Nearby indexed tests and files that appear to be tests |
| `changed_symbols` | Added, modified, and deleted symbols compared with the immediately preceding map snapshot; this is not a Git diff |
| `semantic_context` | The selected structural symbol and an explicit notice that automatic semantic enrichment is disabled |
| `source_ranges` | File and range pointers for stable symbol IDs, plus a live `current`, `changed`, `missing`, `outside_repository`, or `unreadable` source-freshness result |
| `refresh_index` | An explicit atomic incremental refresh of the supported source set |

Symbol-taking actions accept a stable node ID, a qualified name, or a unique simple name. Ambiguous names fail with candidate IDs rather than choosing silently. Results include map revision and completion metadata, and report truncation where a configured bound was reached.

## Supported files and bounds

The current extractor recognizes:

- Python: `.py`, `.pyi`
- JavaScript and TypeScript family: `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`

Parsing and relationship resolution are static and best effort. Dynamic imports, runtime dispatch, reflection, generated code, monkey patching, and framework-specific conventions can be incomplete. Syntax or extraction problems are returned as diagnostics, and unresolved relationships remain visibly unresolved instead of being presented as facts.

Resource bounds are intentionally conservative:

- at most 10,000 supported files per scan;
- at most 2 MB per file;
- at most 100 MB of supported source across one scan;
- at most 2,000 extracted nodes and 5,000 extracted non-containment references per file;
- query-specific result limits, with graph depth capped at 8;
- generated/dependency directories such as `.git`, `.next`, `.venv`, `build`, `coverage`, `dist`, `node_modules`, `out`, `target`, and `vendor` are skipped;
- symbolic links are skipped, keeping discovery inside the selected workspace without following linked trees.

## Cache, privacy, and source authority

The desktop cache is stored beneath Electron's per-user application-data directory:

```text
<userData>/codebase-map/v1/<project-root-hash>/map.json
```

The legacy daemon uses the same `codebase-map/v1/...` layout beside its configured state file. Each cache contains structural metadata such as the selected root, project-relative file paths, symbol names and signatures, source ranges, relationships, diagnostics, and content hashes. It does not store complete source-file bodies.

Cache files are versioned and validated when loaded. Missing, malformed, incompatible, or structurally invalid cache data is ignored and rebuilt from the selected project's current supported source files.

Every query includes `map.index_truncated`, which reports omitted supported source or graph data, including indexing limits and parse failures. Top-level `truncated` is true when either the index or that query's result is incomplete. An empty result from an incomplete index is not evidence that a symbol or dependency is absent. Older caches without completeness metadata are rebuilt automatically.

Index construction itself performs no network request. When the agent invokes `codebase_map`, however, that action's bounded result is added to the agent conversation and sent to the selected OpenRouter model, just like a filesystem or Git tool result. Do not enable the feature for a project whose structural metadata must not be shared with the configured model provider.

The indexer only reads the selected project. Its cache lives outside the project and is not a project artifact. Deleting a project's cache while Span is closed is safe; the map will be rebuilt if the feature is enabled again. Turning the toggle off is sufficient to remove the tool from new runs and does not require deleting the cache.

Always treat the live source tree as authoritative. In particular:

- confidence and `evidence_class` describe how a relationship was inferred;
- a source range is a pointer into the indexed revision, not a substitute for reading the file;
- `changed_symbols` compares map snapshots, not commits, the working tree, or a remote branch;
- impact and test results are candidate sets, not proof of runtime behavior or test coverage.

## Isolation and removal seams

The implementation is concentrated in two self-contained directories:

- `apps/daemon/src/codebase-map/` — parsing, identities, incremental indexing, cache, queries, tool schema, and unit tests
- `apps/desktop/src/renderer/src/codebase-map/` — the complete settings UI and its styles

The renderer settings directory also contains the independent repository-memory preference. Preserve that section and its wiring if removing only codebase mapping.

To remove the map feature from a future branch, remove its implementation and only these integration seams:

1. Daemon runtime wiring in `apps/daemon/src/config.ts`, `runtime.ts`, `agent-runner.ts`, and `tool-executor.ts`, plus the codebase-map fixture field in `project-start.test.ts` and `BROWSER_AGENT_CODEBASE_MAP_ENABLED` in `.env.example`.
2. Desktop preference and UI wiring in `apps/desktop/src/main/settings-store.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/shared/contracts.ts`, and `apps/desktop/src/renderer/src/App.tsx`, plus the related assertions in `settings-store.test.ts` and `settings-panel.test.ts`.
3. The `@vscode/tree-sitter-wasm` dependency in `apps/daemon/package.json`, its generated lockfile entries, and the codebase-map `extraResources` entry in `apps/desktop/package.json`.
4. This document and the small references in `README.md`, `docs/ARCHITECTURE.md`, and `docs/STATUS.md`.

No shared protocol tool schema needs to be unwound: `codebase_map` is registered dynamically by the daemon only while the feature is enabled.
