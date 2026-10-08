# Manual smoke test

## Desktop smoke test (primary)

Record Windows version, Span version, installer filename/hash, selected model, and target-project runtime.

1. Install on a user account without a repository checkout, Node, or pnpm required by Span itself.
2. Launch from the Start menu. Confirm only one instance opens and the first-run checklist points to Settings.
3. Save a limited OpenRouter test key. Confirm the UI reports OS-backed protection, refreshes models, never redisplays the key, and the settings JSON contains no plaintext fragment.
4. Choose the demo or another disposable project with the native picker. Confirm framework/runtime, command, and workspace path.
5. Start the development process and open its localhost URL in the embedded browser. Test back, forward, reload, and blocked non-loopback navigation.
6. Ask the agent to inspect the page and read one project file. Confirm browser context and filesystem reads complete without approval.
7. Request one file edit and one command in `ask` mode. Reject each first and verify no side effect; rerun and approve, then review the exact diff/output.
8. Cancel an active run and confirm pending browser/approval work ends visibly.
9. Start a second chat, use History to switch between both transcripts, then delete one. Close and relaunch; confirm the remaining conversation and its session are restored.
10. Close the app while its managed development process is running; confirm the process tree exits.
11. Relaunch. Confirm non-secret project/model preferences persist, the provider remains configured, and no terminal/daemon/extension/token setup is requested.
12. Uninstall and confirm the installed binaries/shortcuts are removed. Decide separately whether retained per-user settings are intended for the release.

The remainder of this document covers the optional Chrome compatibility mode.

Use this checklist for an unpacked development build. Run it in a clean or committed worktree and use a limited OpenRouter key. Record the Chrome version, Node version, operating system, commit, model ID, and time of the run.

## Preconditions

- [ ] `pnpm check` completes.
- [ ] `.env` exists locally, contains a test OpenRouter key and random daemon bearer token, and is not tracked by Git.
- [ ] Chrome is version 125 or newer.
- [ ] `apps/extension/dist` is loaded unpacked and reloaded after the latest build.
- [ ] The daemon is bound to `127.0.0.1:3210`.
- [ ] The demo is visible at `http://127.0.0.1:4173`.
- [ ] The extension Settings URL and token exactly match the daemon.
- [ ] Chat's Getting started checklist distinguishes daemon reachability, token authentication, model, project, and page readiness.

## 1. Demo page baseline

1. Open `http://127.0.0.1:4173` at a desktop viewport.
2. Confirm the header, hero, product preview, trust strip, three feature cards, workflow, customer story, CTA form, and footer render without horizontal scrolling.
3. Resize below 760 px. Open and close the menu with `#menu-toggle`; verify `aria-expanded` changes and navigation closes after choosing a link.
4. Submit `#early-access-form` with an invalid email. Verify visible error status and focus on `#email-input`.
5. Submit a valid address. Verify the local success state and disabled controls. No network request should be made by the demo form.

## 2. Extension connection and persistence

1. Click the toolbar action while the demo tab is active. Confirm the side panel opens.
2. Save `http://127.0.0.1:3210` and the bearer token.
3. Confirm the health state is connected and no secret appears in logs or page DevTools.
4. Create two chats, switch between them in History, then close/reopen the panel and reload the extension. Confirm settings and both transcripts survive.
5. Enter a wrong token. Confirm privileged operations fail clearly; restore the correct token.

Expected: configuration accepts loopback HTTP only. A LAN URL, public URL, HTTPS URL, malformed URL, or missing token must not silently downgrade security.

## 3. Project selection and process control

1. Select the absolute `examples/demo-app` directory.
2. Confirm detection identifies a Node/Vite project and the `dev` script.
3. Stop the separately started demo if necessary, then start it from the panel.
4. Confirm process state becomes running and logs show the 4173 address.
5. Restart, then stop. Confirm state transitions and bounded logs.
6. Attempt to start twice. Confirm a second process is rejected.
7. Attempt to select a file or nonexistent path. Confirm a structured error.

Expected: the daemon controls one process rooted in the selected workspace and does not leave a process tree after Stop.

## 4. Picker and context capture

1. Start the picker and hover `#hero-title`. Confirm the overlay tracks its bounds while scrolling.
2. Select `#hero-title`, `#feature-card-alignment`, and `#form-submit` in multiple-selection mode.
3. Confirm each selected item has a readable label, tag, bounds, selector/ancestry, classes, short HTML, and bounded style context.
4. Remove one selection, clear all selections, and start/stop the picker repeatedly.
5. Select nested content such as the SVG inside `#hero-primary-cta`; confirm the picker remains usable and does not capture its own overlay.
6. Resize the viewport and repeat on a stacked feature card.
7. Refresh or navigate. Confirm old selection IDs are cleared or explicitly marked stale.

Expected: picker UI is temporary, page links do not activate when a selection click is intercepted, and no model/daemon call is required to select an element.

## 5. Visual preview history

1. Select `#feature-card-clarity`.
2. Apply a clearly visible, valid style change such as background color or padding.
3. Confirm a visual delta records the property and before/preview values.
4. Apply a second change, undo twice, redo twice, then discard.
5. Confirm discard restores the original inline state and clears the preview history.
6. Apply a style to two selectors and verify both revert.
7. Try an unsupported or malformed property/value and confirm it fails without arbitrary script execution.

Expected: a preview never claims a source file changed. `git diff` should remain clean for preview-only operations.

## 6. Workspace containment and approvals

Use only disposable test files inside the selected demo directory.

1. Ask the agent to list/read/search the demo source. Confirm results stay inside the project.
2. Attempt `../`, an absolute external path, and a symlink that resolves outside the workspace. Confirm all are rejected.
3. In `ask` mode, request creation of a harmless temporary file. Confirm the exact path and content summary appear before execution.
4. Reject. Confirm the file does not exist.
5. Repeat and approve. Confirm the file is created and visible in `git status`; manually remove it afterward.
6. Request a harmless bounded command such as the demo build. Reject once and approve once.
7. Switch to `deny`; confirm write, command, and browser side effects are blocked.
8. Treat `auto-safe` as experimental: confirm it never auto-runs commands or browser side effects.

Expected: every path is canonicalized immediately before use, rejection is final for that tool call, and approval times out rather than waiting indefinitely.

## 7. Model discovery and tool loop

1. Refresh models and confirm returned models advertise tool support.
2. Select one explicit model ID; record it in the test notes.
3. Send a question that needs no tool. Confirm assistant output and a completed event.
4. Ask for the demo's title from `index.html`. Confirm a read tool starts, finishes, and the final answer cites the observed value.
5. Trigger a run that asks for a write, reject it, and confirm the model receives a tool error rather than a fabricated success.
6. Start a longer run and cancel it. Confirm no later tool action executes and the run ends as cancelled.
7. Disconnect the daemon mid-run. Confirm the UI reports interruption, not completion.
8. If a model returns an empty completion, confirm the UI recommends retrying or choosing another tool-capable model and never displays an empty assistant card.

Expected: tool arguments are parsed against the named schema, each result matches the tool-call ID, the complete tool list is sent on every OpenRouter turn, and a bounded loop prevents runaway calls.

## 8. Browser actions and debugger limits

1. Run read-only page context and inspect-element actions.
2. In `ask` mode, request navigation/click/type. Reject and verify no side effect; approve a harmless action and verify the intended tab only.
3. Attach a debugger-backed feature and then open DevTools for that tab. Confirm detachment is visible.
4. Refresh or navigate during inspection. Confirm stale CDP node IDs are not reused.
5. Try the picker/action on `chrome://extensions`. Confirm the unsupported target is explained.
6. Test a page containing a cross-origin iframe. Confirm top-frame-only limitations are explicit unless recursive flattened child sessions are active and correctly correlated.
7. Open two tabs and verify a request never executes against the wrong tab.

Expected: browser methods are allowlisted, attachment state is visible, and the user always knows which tab will receive a side effect.

## 9. Security regression checks

- [ ] Search extension output, daemon logs, page storage, chat history, and screenshots for the OpenRouter key; it is absent.
- [ ] Privileged daemon routes reject missing and incorrect bearer tokens.
- [ ] Requests with a disallowed Origin are rejected.
- [ ] Oversized messages/files/tool arguments fail with bounded structured errors.
- [ ] Compound commands and shell redirection are rejected.
- [ ] The extension contains no remotely hosted executable code and no `eval`/`Function` path.
- [ ] `chrome.storage.local` access is restricted to trusted extension contexts.
- [ ] Stopping the daemon or extension cleans up pending approvals, browser requests, picker overlays, previews, and debugger attachment.

## Exit criteria

The smoke test passes only when every unexpected mutation is absent, failures are visible, `git diff` contains only intentional approved changes, and any skipped item is recorded as a known limitation in [Feature and API status](STATUS.md) or [Roadmap and deferred work](ROADMAP.md).
