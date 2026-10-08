# Desktop setup and local development

## Desktop edition (recommended)

End users install **Span** and complete setup inside the application. They do not need this repository, Node.js, pnpm, `.env`, a separate daemon terminal, a Chrome extension, a daemon URL, or a pairing token.

First run:

1. In **Settings**, save an OpenRouter API key. The main process encrypts it with the operating system's credential protection; the renderer receives only a configured/not-configured flag.
2. In **Project**, use **Browse…** to select a folder. Review the detected development command and enter the project's localhost URL.
3. In **Models**, choose a tool-capable model.
4. Start the development process from **Project**, or run it separately.
5. Work in **Chat** beside the isolated browser pane.

The selected project must still have its own runtime and dependencies available. Span does not silently install project toolchains.

### Build and run from source

```powershell
corepack enable
pnpm install
pnpm check
pnpm dev:desktop
```

Create the Windows installer with:

```powershell
pnpm package:desktop
```

The output is under `apps/desktop/release`. It is unsigned until a Windows code-signing certificate is configured, so use the artifact for local evaluation rather than public distribution.

## Legacy Chrome extension development

The remainder of this guide describes the optional extension/loopback-daemon compatibility path. It is not required by the desktop edition.

## Prerequisites

- Chrome 125 or newer. The exact compatibility constraints are documented in [Chrome 125+ constraints](CHROME_CONSTRAINTS.md).
- Node.js 22 LTS. Vite 7 also supports Node 20.19+, but Node 22 is the recommended baseline.
- pnpm 11.19 through Corepack.
- An [OpenRouter API key](https://openrouter.ai/docs/quickstart) if you want live model discovery or agent runs.

The static demo works without an OpenRouter key or the extension.

## 1. Install dependencies

From the repository root:

```powershell
corepack enable
pnpm install
```

On macOS or Linux, the commands are the same. Do not run the daemon with elevated privileges.

## 2. Configure the local daemon

Create a private environment file from the example:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

This preserves an existing private `.env` file.

macOS/Linux:

```sh
[ -f .env ] || cp .env.example .env
```

Set these values in `.env`:

```dotenv
OPENROUTER_API_KEY=your_key_here
BROWSER_AGENT_TOKEN=replace_with_a_long_random_value
BROWSER_AGENT_PORT=3210
```

Keep the file local. The repository ignores `.env`; never paste it into chat or commit it. The daemon is hard-coded to bind to `127.0.0.1`. Port `3210` matches the extension's default URL, `http://127.0.0.1:3210`.

If `BROWSER_AGENT_TOKEN` is omitted, the daemon creates an ephemeral token at startup. A configured token is preferable because the extension must present the same value after every daemon restart.

## 3. Build everything

```powershell
pnpm build
```

The unpacked extension is produced in `apps/extension/dist`. The demo is produced in `examples/demo-app/dist`. For validation, use:

```powershell
pnpm check
```

## 4. Load the unpacked extension

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select the absolute `apps/extension/dist` directory from this repository.
5. Pin **AI Browser Developer Agent** to the toolbar.
6. Click the toolbar icon on an ordinary `http://` or `https://` tab to open the side panel.
7. In Settings, enter `http://127.0.0.1:3210` and the same `BROWSER_AGENT_TOKEN` stored in `.env`.

The Chat view now presents a guided **Getting started** checklist. It separately verifies that the daemon is reachable and that the pairing token is accepted, so a green health endpoint alone is not mistaken for a working connection. Follow its links to choose a model and project, then refresh the local app tab once so the page picker is available.

Chrome will show a strong permission warning because the manifest requests `debugger`. That warning is expected; read [Security policy and threat model](../SECURITY.md) before accepting it. Chrome documents the warnings in its [permission warning list](https://developer.chrome.com/docs/extensions/reference/permissions-list).

After rebuilding the extension, return to `chrome://extensions` and click its reload button. Refresh any test tab so the updated content script is present.

## 5. Start development services

Run all three workspaces together:

```powershell
pnpm dev
```

Expected local services:

| Component | Address or output |
| --- | --- |
| Demo app | `http://127.0.0.1:4173` |
| Daemon API | `http://127.0.0.1:3210` |
| Extension | rebuilds `apps/extension/dist` in watch mode |

Or use separate terminals:

```powershell
pnpm dev:daemon
pnpm dev:extension
pnpm dev:demo
```

The daemon watcher may restart when source changes. Restarting interrupts active SSE agent runs and invalidates any generated ephemeral token.

## 6. Select the demo project

In the side panel's Project view:

1. Enter the absolute path to `examples/demo-app`.
2. Confirm the detected Vite project and `dev` command.
3. Use `http://127.0.0.1:4173` as the project URL.
4. Start the development process only if the demo is not already running in another terminal.

Do not start the same dev server twice; the second process will fail because port 4173 is already occupied.

## Demo-only workflow

To exercise the page without the daemon or extension:

```powershell
pnpm dev:demo
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The page includes stable IDs, semantic classes, and `data-testid` attributes on the hero, product preview, repeated cards, workflow steps, quote, CTA, form controls, navigation, and footer. Its mobile menu and form feedback are local-only interactions; the form does not send data anywhere.

## Common problems

### Side panel does not open

- Use Chrome 125 or newer.
- Open a normal `http://` or `https://` page; protected pages cannot be targeted.
- Reload the extension after a build.
- Click the toolbar action. `chrome.sidePanel.open()` must follow a user gesture; see the [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

### Extension cannot reach the daemon

- Confirm the daemon is running and its port matches Settings.
- Confirm the token matches exactly.
- Keep the URL on loopback and use `http`, not `https`.
- Do not replace `127.0.0.1` with a LAN hostname or address.

### Picker is missing on a page

- Refresh the tab after reloading the extension.
- Content scripts do not run on `chrome://` pages or the Chrome Web Store.
- A cross-origin iframe is not covered by the MVP's top-frame content script.

### Debugger detaches

Opening Chrome DevTools for the same tab can detach the extension. Close DevTools and retry, or use another tab. The extension should report the detach state instead of silently continuing; see the [Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger).

### OpenRouter returns no tool-capable models

Confirm the key is valid and refresh discovery. The daemon should query the models endpoint with `supported_parameters=tools`; model metadata changes over time. See [OpenRouter model discovery](https://openrouter.ai/docs/guides/overview/models).

Continue with the [Manual smoke test](SMOKE_TEST.md).
