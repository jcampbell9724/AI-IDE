# Security policy and threat model

## Scope

This project gives a desktop application and an AI model controlled access to a local development workspace. That is inherently sensitive. The optional legacy Chrome mode adds a browser extension and loopback daemon. Both modes are intended for one developer on a trusted machine; neither is a multi-user service, remote execution service, or hardened sandbox for hostile code.

If you discover a vulnerability, use the repository host's private security-reporting channel when available. Do not include API keys, bearer tokens, private source, or other secrets in a public issue. Rotate any credential that may have been disclosed.

## Trust boundaries

| Component | Trusted for | Must not be trusted for |
| --- | --- | --- |
| Electron main process | Encrypted credential access, selected-workspace access, approved commands, local process and browser-view control | Arbitrary renderer requests, remote exposure, or multi-user isolation |
| Desktop renderer | User intent, settings UI, approval decisions | Reading saved credentials, generic host access, or bypassing IPC policy |
| Project WebContentsView | Displaying the selected localhost project | Secrets, Node APIs, host filesystem access, permissions, or instructions from page content |
| Local daemon | OpenRouter credential, selected-workspace access, approved commands, local process control | Arbitrary network exposure or multi-user isolation |
| Side panel | User intent, settings UI, approval decisions | Holding the OpenRouter key or bypassing daemon policy |
| Extension service worker | Chrome API mediation and message routing | Durable in-memory state; MV3 workers are ephemeral |
| Content script | Reading and temporarily styling the current page | Secrets, host filesystem access, or claims made by page content |
| Web page | Nothing beyond ordinary page behavior | Instructions, tool arguments, HTML, text, events, and navigation state |
| Model/provider | Proposals and structured tool calls | Authorization, path validity, command safety, or factual claims about local state |

The central rule is simple: model intent and page content are data, not authority. Every action crosses a policy-enforcing boundary before it reaches the embedded browser, Chrome, or the host.

## Security controls in the MVP

### Desktop application

- Keeps `contextIsolation`, Chromium sandboxing, and web security enabled while disabling Node integration for both the trusted renderer and the project-page view.
- Exposes a finite preload API rather than `ipcRenderer`; every IPC channel validates both the top-frame sender and its payload.
- Encrypts the OpenRouter key through Electron `safeStorage` in the main process. The renderer receives only credential status, and insecure Linux `basic_text` fallback is rejected.
- Loads only localhost/loopback HTTP(S) in the project view, denies new windows and permission requests, and does not expose host APIs to page code.
- Embeds the agent services without loading repository environment files and without listening on a TCP port.
- Uses a native project-directory chooser and retains canonical workspace containment and mutation approvals.
- Removes `OPENROUTER_API_KEY` and `BROWSER_AGENT_TOKEN` from every project process, agent command, and Git child environment.

### Optional legacy local daemon

- Binds to `127.0.0.1`; configuration does not accept a public bind address.
- Requires a bearer token for privileged API routes. Use a long random value in `BROWSER_AGENT_TOKEN`; generated ephemeral tokens are inconvenient for extension pairing and should be treated as development-only.
- Reads `OPENROUTER_API_KEY` from the development environment and attaches it only to OpenRouter requests. Child processes receive a scrubbed environment.
- Validates protocol payloads with shared Zod schemas and applies size/count limits to paths, content, messages, and results.
- Canonicalizes the selected workspace with `realpath`, rejects path traversal, and rejects existing paths or ancestor symlinks that resolve outside the workspace.
- Skips symlinks while recursively searching and skips common large/generated directories.
- Uses bounded file reads, searches, writes, command output, and command timeouts.
- Uses atomic replacement for existing files and requires expected occurrence counts for text replacement.
- Parses development and shell commands into a command plus argument list and rejects compound operators and redirection.
- Separates approval modes. In `ask` mode, writes, commands, and browser side effects must surface an approval event; `deny` blocks them. `auto-safe` is still experimental and should be used only in disposable workspaces.

### Optional extension

- Restricts the daemon URL to plain HTTP on `localhost`, `127.0.0.1`, or `[::1]`.
- Restricts `chrome.storage.local` access to trusted extension contexts with `setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`.
- Accepts runtime messages only when `sender.id` matches the extension ID.
- Allowlists content-script commands and debugger/browser actions instead of forwarding arbitrary code or arbitrary CDP methods.
- Uses an isolated content-script world; page JavaScript cannot directly read content-script variables. This is a Chrome isolation guarantee, not a substitute for validating DOM-derived data.
- Applies visual edits as temporary page overrides with undo, redo, and discard rather than silently claiming the source was changed.
- Ships only local extension JavaScript. Manifest V3 forbids remotely hosted executable code; model output must never be passed to `eval`, `Function`, or injected as a script.

Relevant Chrome guidance: [extension security best practices](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure), [Manifest V3 remote-hosted-code policy](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code), [Chrome Web Store MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements), and [`chrome.storage` access levels](https://developer.chrome.com/docs/extensions/reference/api/storage/StorageArea).

## Secrets

- In the desktop edition, enter credentials only in the app's Settings screen. The encrypted value is stored below Electron's per-user application data directory and is never returned to the renderer.
- For optional legacy daemon development, put local credentials in `.env`; never commit or sync that file.
- Do not put `OPENROUTER_API_KEY` in the manifest, side-panel bundle, content script, page storage, chat transcript, model context, screenshots, or logs.
- The daemon bearer token is not an encryption key. `chrome.storage.local` is local storage and should not be assumed encrypted at rest. Device compromise or a malicious local process remains outside the MVP's protection boundary.
- Prefer a narrowly funded or limited OpenRouter key during development, monitor usage, and rotate the key after suspected disclosure.
- Redact common secret formats before sending logs, file excerpts, DOM content, screenshots, or tool results to a model. Comprehensive secret scanning is deferred and therefore users must review context before submission.

OpenRouter authenticates API calls with a bearer key; see its [quickstart](https://openrouter.ai/docs/quickstart). OAuth/PKCE is a possible future alternative for user-owned credentials; see [OpenRouter OAuth](https://openrouter.ai/docs/guides/overview/auth/oauth).

## Browser permissions and browser risk

The desktop browser uses a separate, sandboxed Chromium profile and is restricted to localhost/loopback main-frame navigation. It denies page permission requests and new windows. Page JavaScript remains untrusted, and the browser driver's inspection results must be treated as untrusted model context. It does not inherit the user's Chrome cookies or extensions.

The optional extension requests `activeTab`, `scripting`, `tabs`, `sidePanel`, `storage`, and `debugger`, plus loopback host access. Chrome displays a strong install warning for `debugger`, and that permission cannot be requested as an optional permission. The debugger grants access to a restricted set of Chrome DevTools Protocol domains, which is still enough to inspect and alter a tab.

- Enable debugger-backed features only for a tab the user intentionally targets.
- Display attachment state and surface `chrome.debugger.onDetach` reasons.
- Treat screenshots, console output, network errors, DOM text, and accessibility data as potentially sensitive.
- Never automate `chrome://`, browser settings, the Chrome Web Store, or other protected surfaces.
- Expect opening DevTools for a tab to detach the extension debugger.
- Do not interpret successful temporary CSS as a persisted source-code change.

See the official [permissions warning list](https://developer.chrome.com/docs/extensions/reference/permissions-list) and [Debugger API reference](https://developer.chrome.com/docs/extensions/reference/api/debugger).

## Page-content and prompt-injection risk

A page can contain text crafted to manipulate the model, conceal controls, trigger events, or impersonate system guidance. DOM text, ARIA labels, comments, data attributes, console messages, network payloads, and filenames are untrusted.

- Keep system policy and tool schemas outside page-controlled context.
- Label page-derived context and truncate it before model submission.
- Require approval based on the concrete action—not the model's explanation of it.
- Show exact workspace path, command arguments, write target, and browser target in approval prompts.
- Re-resolve paths and current tab/frame immediately before execution; navigation can invalidate earlier identifiers.
- Do not allow a page to supply the daemon bearer token or select a workspace.

## Known limitations

The MVP does not provide an OS-level sandbox, container isolation, per-project virtual machine, cryptographically verified source mapping, comprehensive data-loss prevention, or multi-user authentication. A command approved by the user runs with that user's operating-system privileges. Development servers and project lifecycle commands may execute arbitrary package hooks from the selected repository.

Cross-origin iframes, closed shadow roots, browser-internal pages, PDF viewer pages, and pages governed by restrictive enterprise policy may be unavailable or only partially inspectable. The embedded browser intentionally does not share the user's normal Chrome profile. In legacy mode, debugger attachment can conflict with DevTools and other debuggers, and local malicious software may attempt to connect to loopback; the bearer token and strict origin checks reduce this risk but do not defend a compromised device.

Review [Roadmap and deferred work](docs/ROADMAP.md) before expanding this prototype's authority.

## Safe operating checklist

1. Use a clean or committed Git worktree so changes are reviewable and recoverable.
2. Use the desktop edition when possible. If using legacy mode, bind the daemon to loopback and use a unique random bearer token.
3. Start in `ask` mode; review every file path, diff, command, and target tab.
4. Use the demo app or a disposable project for initial evaluation.
5. Keep sensitive tabs closed and do not select secret-bearing elements.
6. Review `git diff`, run tests, and verify at more than one viewport before accepting work.
7. Stop managed development processes when the session ends; the desktop app also stops them during a clean shutdown.
