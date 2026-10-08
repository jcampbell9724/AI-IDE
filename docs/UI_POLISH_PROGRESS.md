# UI polish progress

Work follows the user's approved review list in order, verifying each item before starting the next.

1. **Implemented:** Preview startup waits for a local HTTP response, with starting, waiting, ready, missing-URL, and failure states. Checks stop after 60 seconds and cancel on stop, restart, project selection, manual navigation, or shutdown. Loading navigation is abortable. Stop/Restart remain available during readiness checks.
2. **Implemented:** Project startup and manual preview errors appear beside the preview. Recovery actions open live logs, retry the preview/start the project, or open the run-command editor (explicitly stopping a running project first). Logs preserve scroll position, support following latest output, bound retained output, retry temporary errors, and ignore late responses after closing/switching projects.
3. **Implemented:** Startup offers Resume workspace alongside Choose another project. The selected model persists across launches. Selecting a project restores its selected chat, file tabs (loaded on demand), selected file/Preview, sidebar, and chat/file reading positions. Resumption does not automatically launch the project server or an agent run. Invalid or unavailable saved layout data falls back to an empty workspace.
4. **Implemented:** Unsent drafts persist with each project's chat history, including a draft before any chat exists. Draft-only chats survive chat creation and switching. Sending clears only the submitted draft; the sidebar marks chats containing drafts.
5. **Implemented:** Chat, chat-history, model-setup, and preview empty states provide direct next actions. Starter prompts fill the composer for review without sending, and existing drafts are preserved.
6. **Implemented:** Provider errors offer relevant API-key/model settings and model-list reload actions. Confirmed failures before any tool activity or visible assistant output allow retrying without duplicating the user message or clearing a new draft. Partial output, tool activity, uncertain IPC results, and non-retryable errors offer original-request review and optional draft reuse. Recovery actions are invalidated on chat/project changes; setting changes never automatically resend a request.
7. **Implemented:** The composer remains editable during a run, saves the next draft, and prevents Enter from submitting until the run finishes. Stop remains available.
8. **Implemented:** A persistent strip shows the project, selected model, server state, and agent activity, with direct access to project/model selection.
9. **Implemented:** Model choices show image support, context size, and input/output prices per million tokens. An explicit starting suggestion prioritizes image support and lower input prices among tool-capable models; it never auto-selects or claims to rank quality.
10. **Implemented:** Setup shows progress through provider connection, model selection, and opening a project. Missing steps remain visible when resuming existing chats.
11. **Implemented:** Project switching explicitly stops the current server first, then opens/selects/creates the destination. Labels disclose this behavior; switching remains unavailable during agent runs and duplicate switch requests are prevented.
12. **Implemented:** File refresh retains search, expanded folders, and tree scroll position. Removed folders are dropped and new folders start collapsed. Selecting another project resets its tree state.
13. **Implemented:** Search matches conversation titles, message content, and drafts. Inline rename supports Save/Cancel, Enter/Escape, and custom titles persist across later messages and reloads.
14. **Implemented:** Messages and fenced code blocks offer clipboard copy with local success/failure feedback. Edit and resend creates a new chat containing the preceding messages and edited request, preserving the original conversation and draft. Sending is unavailable while another run is active.
15. Pending: Recoverable chat deletion.
16. Pending: Larger small text and controls.
17. Pending: Consistent recognizable icons.
18. Pending: Chat-focused and preview-focused layouts.
19. Pending: Local, quieter feedback.
20. Pending: Keyboard navigation and shortcuts.

Additional user request: sending with no selected chat now automatically creates a new conversation and uses its session for the first message. Blank submissions do not create chats; an existing selected chat continues normally.

Additional user request: projects without a detected run command now start a built-in localhost HTML preview. It serves web assets, supports a single named HTML page or a page picker, reuses the previous port when available, and stops with the project. Browser storage and existing APIs keep their normal browser behavior, including origin/CORS requirements. Database files and private paths are not exposed as web assets.

Automatic backend detection supports package scripts, conventional Node/Bun entry points, Flask, FastAPI, and Django. Preview addresses come from local URLs in process output or explicit command/Node source ports. Detection starts the backend already defined by the project; it does not install runtimes/dependencies, provision database servers, create an API from a database file, or configure separate frontend/API deployments. Unrecognized setups still accept a manual command and preview URL.

Validation: workspace type checking, all production builds, and 357 tests passed (201 desktop, 79 daemon, 64 extension, 13 shared). Native desktop visual/interaction validation and installer replacement are still outstanding. HTTP readiness establishes that a local server responds; it does not prove the application has no runtime errors.
