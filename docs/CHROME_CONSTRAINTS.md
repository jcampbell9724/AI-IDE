# Chrome 125+ constraints

The unpacked extension declares `minimum_chrome_version: 125`. This is an implementation baseline, not a claim that every Chrome 125 page can be automated.

## Side Panel API

The [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) requires the `sidePanel` permission and a local `side_panel.default_path` in the manifest.

- Side panels are available from Chrome 114.
- `chrome.sidePanel.open()` is available from Chrome 116 and must be called in response to a user gesture.
- `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` lets a toolbar click open the panel.
- `chrome.sidePanel.setOptions()` can enable or disable a panel per tab.
- `chrome.sidePanel.close()` is Chrome 141+, so the MVP must not call it or rely on it for cleanup.

The service worker should register action and tab listeners at top level. If a programmatic open is rejected because gesture eligibility has expired, ask the user to click the toolbar action again.

## Manifest V3 service worker

The background worker has no DOM or `window`. Chrome can terminate it after roughly 30 seconds of inactivity, if a single request runs longer than five minutes, or if a `fetch()` response takes longer than roughly 30 seconds to arrive. An active debugger session keeps the service worker alive starting in Chrome 118, but durable application state must still not depend on worker memory.

Use top-level listener registration, persist settings/state, and design every handler to survive restart. See [service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) and [migration guidance](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers).

## Chrome messaging behavior

The MVP uses one-time messages between the side panel/service worker and the content script. On the Chrome 125 baseline:

- Use `chrome.runtime.sendMessage()` or `chrome.tabs.sendMessage()`.
- Parse and validate every message; pages can indirectly influence its data.
- Chrome serializes messages as JSON and limits a message to 64 MiB. This project applies much smaller protocol limits.
- When responding asynchronously from `onMessage`, call `sendResponse()` and return the literal `true` from the listener.
- Do not make the listener itself `async` for the Chrome 125 baseline. Promise-returning listeners only became broadly documented for much newer Chrome versions.
- Only one responder may win for a given message.

See [Chrome extension messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging).

## Content-script boundaries

Content scripts normally run in an isolated world. They can inspect and mutate the page DOM but cannot read variables created by page scripts. They have only a limited extension API surface and should route privileged actions through the service worker.

The current manifest injects into ordinary HTTP(S) top frames. Consequences:

- `chrome://`, `edge://`, Chrome Web Store, and other protected pages cannot be scripted.
- The built-in PDF viewer and some extension pages are not valid targets.
- Cross-origin iframes are not covered by a top-frame-only content script.
- Closed shadow roots cannot be traversed from ordinary page JavaScript.
- A same-page framework render can replace an element and invalidate a stored reference or selector.

See [content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).

## Debugger and Chrome DevTools Protocol

The [Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger) requires the non-optional `debugger` permission and triggers a strong install warning. It exposes a restricted set of [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) domains—not arbitrary CDP access.

Implementation rules:

- Attach only when a user invokes a debugger-backed feature; detach when the tab or feature session ends.
- Handle `chrome.debugger.onDetach` and surface the reason.
- Opening DevTools for the target tab can detach the extension debugger.
- Another debugger client can conflict with attachment.
- Use only the domains/methods exposed by `chrome.debugger`; keep an explicit method allowlist in the broker.
- Treat node IDs as session-scoped and navigation-sensitive.
- Never present the debugger notification bar as a security guarantee; authorization still belongs in the product UI.

### Out-of-process iframes

Chrome 125 added flattened child-session support for `chrome.debugger`. After attaching to the main target, use `Target.setAutoAttach` with `flatten: true` to discover immediate related targets. Auto-attach applies one level deep, so the same setup must be applied recursively to newly attached child sessions. Each CDP command/event must be correlated with the correct `sessionId`.

This mechanism does not erase same-origin, permission, enterprise-policy, or protected-page limits. Cross-frame picker UX and robust recursive session management remain deferred.

## Network requests

Extension pages and service workers can fetch a permitted loopback origin because the manifest declares `http://127.0.0.1/*` and `http://localhost/*`. Content-script requests remain subject to the page's origin and should not call the daemon. See [cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

Keep daemon fetches in trusted extension contexts, validate the configured URL as loopback, and authenticate every privileged request.

## Manifest V3 code policy

Manifest V3 requires extension logic to be packaged with the extension. Do not fetch remote JavaScript, use `eval`, construct a `Function`, or interpret model output as code in an extension execution context. The Chrome Web Store policy provides narrow exceptions for APIs such as `debugger` when they are used for their documented purpose; it does not permit a general remote-code runtime.

See [remote hosted code guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code) and the [Chrome Web Store MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements).

## Verification matrix

At minimum, manually test:

| Browser state | Expected behavior |
| --- | --- |
| Chrome 125+ normal HTTP tab | Panel opens; content script and picker can operate |
| Toolbar click | Panel opens because the action is a user gesture |
| Direct call without gesture | Failure is surfaced; no retry loop |
| Page refresh/navigation | Prior selection IDs and preview history are cleared or marked stale |
| DevTools opened on attached tab | Detach is detected and visible |
| Cross-origin iframe target | Clearly reported unsupported or handled through a correctly correlated child session |
| `chrome://extensions` | Picker/browser action is disabled or reports unsupported page |
| Extension worker terminated/restarted | Settings survive; no run is falsely reported complete |
| Narrow and wide viewports | Picker bounds and temporary edits stay aligned after scrolling/resizing |
