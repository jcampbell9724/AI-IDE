# Roadmap and deferred work

The Windows desktop shell, in-app configuration, embedded runtime/browser, encrypted provider storage, native folder picker, and unsigned NSIS installer now exist. The Chrome-extension roadmap below remains relevant to the optional compatibility mode.

This roadmap is intentionally conservative. Items are ordered by risk reduction and end-to-end usefulness, not visual novelty. Dates are not promised.

## MVP integration gate

Before adding authority, finish and verify the narrow local workflow:

- Complete the side-panel connection, project, model, chat, selection, preview, approval, and settings surfaces.
- Finish the loopback HTTP server and make every route parse the shared runtime schemas.
- Complete dynamic OpenRouter tool-capable model discovery with caching, refresh, and clear key/provider errors.
- Complete a bounded, serial (`parallel_tool_calls: false`) agent loop with exact tool-call/result correlation.
- Wire browser request/result correlation and cancellation across daemon, SSE client, service worker, and tab.
- Add contract tests for the extension client against the daemon routes and SSE events.
- Add tests for wrong/missing auth, disallowed origins, traversal, symlink escapes, command metacharacters, output bounds, approval rejection/timeout, and cancellation.
- Pass and record the full [Manual smoke test](SMOKE_TEST.md) on Windows, macOS, and Linux with current Chrome.

## Next: reliability and reviewability

- Durable session metadata and explicit recovery after daemon, panel, or MV3 service-worker restart.
- Run ledger showing prompts, selected context, tool arguments/results, approvals, file diffs, browser targets, duration, and failure reason.
- Clear checkpoints and one-click rollback for approved source mutations.
- Source-aware patch previews with formatting, tests, verification, and a distinction between staged, written, and preview-only changes.
- Improved dev-process port detection, readiness probes, URL discovery, log search, and orphan cleanup.
- Model capability/price/context display with favorites, cache age, deterministic refresh, and provider fallback visibility.
- Sensitive-data redaction and explicit context-size previews before model submission.
- Accessibility and keyboard review for every panel and picker state.

## Later: visual editing that can persist safely

- Evidence-ranked DOM-to-source mapping using source maps, framework metadata, selector search, text matches, and component boundaries.
- A confidence score and candidate list instead of silently choosing a source file.
- Translation of temporary changes into CSS, utility classes, component props, or layout code appropriate to the detected project.
- Responsive breakpoint intent, multi-viewport preview, screenshot comparison, and visual-regression hooks.
- Richer spacing, alignment, reorder, resize, and typography controls with framework-aware constraints.
- Shadow-DOM and iframe UX where Chrome's permission and protocol boundaries allow it.

Until this work exists, temporary DOM/CSS edits remain previews and must not be described as durable source changes.

## Later: browser coverage

- Robust flattened Chrome DevTools Protocol child-session recursion for out-of-process iframes in Chrome 125+.
- Frame-aware selectors, attachment lifecycle, and navigation invalidation.
- Better handling for same-origin iframes and open shadow roots in the content-script picker.
- Network/console timelines, request correlation, downloadable artifacts, and redaction.
- Test recording and replay with assertions, screenshots, and explicit side-effect approvals.
- Multi-tab workflows with visible target locking and prevention of confused-deputy actions.

Protected browser pages, closed shadow roots, and targets Chrome refuses to expose will remain unsupported rather than bypassed.

## Later: stronger host boundary

- Native Messaging packaging as an alternative to loopback HTTP for the optional extension, with extension-ID allowlisting.
- OpenRouter OAuth/PKCE as an alternative to desktop OS-encrypted long-lived keys.
- Sign the existing Windows installer; add automatic updates, dependency attestations, and a documented vulnerability response process.
- Add signed/notarized macOS packaging and tested Linux packages with secure-secret-backend diagnostics.
- Optional sandbox/container profiles for command execution and disposable worktrees for agent writes.
- Granular per-session capabilities, per-tool budgets, command executable allowlists, and project trust prompts.
- Local audit export with secret scanning and configurable retention.

Native Messaging is documented by Chrome at [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). OpenRouter's delegated credential flow is documented at [OAuth](https://openrouter.ai/docs/guides/overview/auth/oauth).

## Later: collaboration and integrations

- Git branches/checkpoints, structured commit preparation, and opt-in commit execution.
- GitHub OAuth or a narrowly permissioned GitHub MCP integration for issues, branches, pull requests, checks, and review comments.
- Shareable run summaries that omit source and secrets by default.
- Team policies for models, approvals, tool budgets, and allowed repositories.
- Reproducible issue-to-fix workflows with human review gates.

No GitHub integration, hosted sync, remote daemon, or team control plane is implemented in the MVP.

## Explicitly out of scope for the current prototype

- A Chromium fork or custom browser distribution.
- General-purpose remote code execution.
- Running the daemon on a LAN or public address.
- Multi-tenant isolation or enterprise administration.
- Autonomous publishing, deployment, purchasing, credential creation, or irreversible external actions.
- Guaranteed inspection of every frame, browser-internal page, extension page, or closed shadow root.
- Claiming a preview is saved when no verified source patch exists.

## Promotion criteria

The prototype should not be called production-ready until it has a stable versioned API, hardened credential storage, platform installers, dependency and release security, broad automated and browser integration tests, external security review, telemetry/privacy controls, upgrade/rollback strategy, and a documented support policy.
