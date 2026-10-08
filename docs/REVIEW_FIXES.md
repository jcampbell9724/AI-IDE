# Review fixes — September 5, 2026

The nine findings from the project review were addressed sequentially, with regression tests run before proceeding to the next finding.

| Finding | Result |
| --- | --- |
| Project switching during an agent run | Project selection is locked for the run's lifetime. Every tool receives the run's original workspace guard. Requests containing an outdated project root are rejected before contacting the model. |
| Stop during streaming | Cancellation remains connected after response headers, cancels the stream reader, suppresses buffered/late chunks, and ends the run as cancelled. |
| Screenshot transport | Screenshots are sent as image content parts after the corresponding tool results. Model image-input capability is checked. Desktop captures are resized to at most 1,600 pixels on the longest edge and encoded as JPEG. |
| Preview setup | Preview has an editable localhost URL and Open button. The URL is saved per project, including when its server is not ready yet. Switching projects clears the previous page and browser history. |
| Failed process launch recovery | A failed spawn clears its process reference. Stop and log clearing remain usable afterward. |
| Localhost redirects | Main-frame redirects use the same localhost policy as navigation. Browser tools also check the current destination before inspection or interaction. |
| Chrome Back/Forward/Refresh targeting | The extension preserves the requested tab ID through all three actions. |
| Chrome screenshot identity | Inactive targets are rejected. Active-tab and page identity are checked around capture, and a capture is discarded if its target changes during the operation. Temporary event listeners are removed on success and failure. |
| Incomplete codebase-map queries | Index completeness is saved in the cache and included in query metadata and truncation flags, including empty results. Missing-symbol errors explain when the index is incomplete. Older caches lacking the new field are rebuilt. |

## Validation

Final `pnpm check` passed:

- TypeScript checks across all workspaces.
- 298 tests: 13 shared, 75 daemon, 64 extension, and 146 desktop.
- Full shared, daemon, extension, desktop, and demo builds.

The new tests cover original-workspace reads and writes, project-lock release, stale requests, cancellation after the first stream chunk, image transport and unsupported models, preview URL persistence and validation, process-spawn failure, navigation and redirect policy handlers, preview cleanup, screenshot sizing, explicit tab targeting, tab changes during capture, and incomplete-index persistence.

Provider requests and Chrome/Electron APIs were mocked in the applicable regression tests. Live provider calls, a full interactive desktop smoke test, and a clean-machine installer test remain separate release checks. The installed application and installer package were not replaced as part of this source-code change.

## Using the updated Preview

Open a project and start its development server. Enter the server's URL, such as `http://localhost:5173`, in the Preview address field and choose **Open**. The app remembers that URL for the project. If the server is still starting, retry **Open** or reload once it is ready.

For Chrome compatibility mode, activate the requested tab before asking for its screenshot. The extension will ask you to retry if the active tab or page changes during capture.
