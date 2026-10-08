# Repository memory in Span

Repository memory helps an agent resume work without reconstructing every decision from an older conversation. It is implemented inside Span's desktop settings and embedded agent runtime. It uses the selected model and existing tools; it does not require an editor extension, external memory server, or second AI provider.

The [codebase map](CODEBASE_MAP.md) and repository memory answer different questions. The map helps locate code and relationships. A task handoff records what the current task is trying to accomplish and what remains. A project note records a decision or a claim that may be useful in later tasks.

## Turn it on

In Span, open the chat pane's **Settings** button, select **Preferences**, and enable **Repository memory → Use repository memory**. It starts off, including after migration from older settings. **Use codebase mapping** is an independent switch in the same panel; either feature can run alone.

The preference is saved in the desktop settings file and passed directly to the embedded runtime. Enabling memory affects a fresh agent run. Disabling it stops new memory reads and saves; the active run can finish through the ordinary flow without a memory checkpoint. A new run receives no memory tool or saved context. Context already sent to a model during an active run cannot be withdrawn. Saved handoffs and notes remain on disk when the switch is off. If a run started with memory enabled and the switch is turned off and back on, its memory session is invalidated: the runner reports that settings changed and requires a new run to restore fresh context.

The optional legacy daemon also accepts `BROWSER_AGENT_REPOSITORY_MEMORY_ENABLED=true` at startup. Desktop users configure the feature in Span.

## What uses logic, and what uses AI

| Responsibility | Implemented by |
| --- | --- |
| Extract symbols and relationships for the optional map | Local parsing and rules; no AI call |
| Locate the project's saved memory and the current chat's handoff | Local logic using project and session identity |
| Rank project notes | Simple word matching against the current request, saved objective, and next steps, then recency |
| Check source evidence, revisions, bounds, and file paths | Local logic |
| Select which facts and decisions deserve a handoff or note | The working AI agent |
| Write a concise account of progress and explain decisions | The working AI agent |
| Enforce checkpoint and completion boundaries | The agent runner's local logic |
| Decide whether a user has revised a previous constraint | AI judgment, recorded with a reason; this is not mechanically proven |
| Record provider-reported usage | Local logic, using usage returned by the selected provider |

There is no background AI summarizer. A checkpoint is a tool action within the same agent run. Writing checkpoints and any extra model turns needed to obtain them still consume tokens, so their cost must be included when evaluating savings.

## End-to-end lifecycle

1. **Start or resume.** Span keeps the selected project stable for the run. With memory enabled, it loads that project's memory, finds the handoff for the chat's persistent session ID, and records that a run has started. A new chat can use project notes, but does not inherit another chat's task handoff.

2. **Build bounded context.** The host combines the current objective, saved handoff, an unfinished-run warning when applicable, and ranked project notes. It checks evidence against current source bytes before including claims about code. Scoped notes and code claims with no matching task terms are omitted; general decision notes can still be included. Notes that do not fit are omitted with a count. It does not silently trim the essential handoff to make room for more notes.

3. **Preserve user instructions.** Saved context is explicitly marked as untrusted historical data. The current user's instructions take precedence. The host records a `historyCheckpoint` with each handoff: the count of the original request messages and a SHA-256 digest of their roles and text. On resume, compression is allowed only when the beginning of the supplied conversation matches that saved count and digest. Only assistant messages within that verified prefix may be omitted. Every user message, the latest assistant message overall, and every message after the verified prefix remain, including replies written while memory was off. A missing checkpoint or mismatched prefix disables compression. The digest identifies the messages available to the run that saved the handoff; it does not prove the handoff summarized them correctly. Compression changes the model request, not the conversation displayed or saved in Span. Existing conversation-storage/request limits still apply.

4. **Investigate current code.** The agent can query `codebase_map` if its separate switch is enabled, then use ordinary source-reading, search, Git, browser, and command tools. The map is queried when needed; enabling memory does not automatically scan a repository or insert a complete map into every request.

5. **Read before editing.** A successful `fs_read` returns a SHA-256 `contentHash`, which the host also remembers for that run. With memory enabled, replacing or overwriting an existing file requires such a read. The write path checks that the source still matches near the final file replacement. A changed file requires another read. A successful edit consumes that remembered read; a command clears all remembered reads because it may change files.

6. **Checkpoint progress.** The agent uses `repository_memory` with `save_handoff` at useful milestones. After six successful non-memory tool operations since the last clean handoff, the runner pauses further ordinary tools until a handoff is saved. A project note does not satisfy this checkpoint. The host checks source evidence and record revisions before persisting it.

7. **Finish through the handoff gate.** A newly started run needs a handoff, and further tool work makes the handoff due again. When the agent attempts a final answer while one is due, the runner holds that answer and asks for the handoff. Repeated refusal fails the run instead of reporting successful completion. Checkpoint turns count toward the existing 24-step model loop limit.

8. **Recover after interruption.** Cancellation and errors record an interrupted marker when possible; a crash can leave the run marked as running. The next run surfaces that unfinished state and the last saved handoff. Unsaved work is not invented or marked verified. The agent must inspect what actually happened before continuing.

## Handoffs, notes, and evidence

A handoff contains the objective, constraints, completed work, decisions, blockers, next steps, validation performed, and optional source evidence. It is saved for a chat session within a project. The agent must preserve the active or previously saved objective. Previous constraints cannot be dropped silently: a change needs a nonempty `constraintsRevisionReason`, which is stored with the handoff. The model must use that exception only for an actual user-requested change. The host can require a reason; it cannot establish that the reason correctly interprets the user's intent.

Project notes have stable IDs, scope paths, a reason, and one of two meanings:

- **Decision:** historical intent, such as why a particular interface was chosen. It can remain useful when code changes, so it is retained with an evidence-status label and a reminder to check whether it still applies.
- **Code claim:** an assertion about current code. It requires source hashes. If evidence is changed, missing, unreadable, or otherwise unverifiable at resume, the claim is withheld from the resume context.

A handoff with changed evidence remains available as historical task context and is labelled stale. Evidence-free handoffs and decisions are labelled unverified. A matching hash proves that the recorded bytes match the checked file; it does not prove that the agent's interpretation or test claim is correct. The working agent must reread relevant source before edits.

Saves use expected revisions. A stale writer receives a conflict instead of replacing newer work. Replacing a decision with a different decision uses a new note ID plus the previous note's ID and revision. The old note is marked superseded and excluded from active context. Superseded notes cannot be rewritten and may eventually be removed to keep history bounded.

## Storage and limits

The desktop stores memory outside the project, beneath Electron's per-user application-data directory:

```text
<userData>/repository-memory/v1/<project-root-hash>/memory.json
```

The legacy daemon uses the same layout beside its configured state file. The hash uses the resolved project root, so moving a project changes its memory identity; automatic migration between project locations is not implemented.

The JSON file contains the root identity, handoffs, project notes, evidence hashes and paths, and recent run metrics. It contains agent-written text, not full source-file snapshots. Writes are serialized in the process, use a project lock to reject competing writers in another process, and replace the saved file atomically. Invalid saved state is reported and preserved for repair rather than silently discarded. A lock left by a crashed process requires recovery only after confirming that the process is stopped.

| Bound | Current value |
| --- | --- |
| Resume context | 12,000 UTF-8 bytes |
| Handoff body | 8,000 UTF-8 bytes |
| Project note input | 5,000 UTF-8 bytes |
| Complete memory file | 2,000,000 bytes |
| Source file checked as evidence | 2,000,000 bytes |
| Retained task handoffs | Latest 50 sessions per project; one current handoff per session |
| Project notes | At most 100; superseded history is removed before active notes |
| Run records | Latest 100 per project |
| Each handoff list / evidence list | At most 20 entries |
| Scope paths per project note | At most 10 |

The displayed current objective is additionally limited to 2,000 serialized JSON bytes, and an unfinished-run reason to 700. Long display text carries a notice; the actual current user message remains in the request.

Turning memory off preserves this file. Removing it while Span is stopped removes the saved continuity; unlike the structural map, decisions and handoffs cannot be rebuilt from source alone. There is no dedicated viewer, selective-delete control, export flow, or automated repair interface for saved handoffs and project notes in this first implementation. Run-report controls described below manage diagnostic reports only.

Memory construction and persistence perform no network request. The selected context and memory tool exchange become part of the conversation sent to the configured model through OpenRouter. The agent is instructed not to store secrets or large copied source blocks. No separate AI service validates or cleans those notes.

The source checks apply to the typed file tools. Approved commands can also modify files, and the runtime does not provide an operating-system sandbox around them. A final hash check narrows the window for overwriting external edits; it is not an atomic operating-system compare-and-swap with every external writer.

## Metrics and token-savings evaluation

Each retained memory run records start/update times, completion or interruption status, injected context bytes, an estimated context token count, handoff and note save counts, and provider input/output/total tokens when available. The context estimate is `ceil(bytes / 4)` and is not a tokenizer measurement. Missing provider counts mean unavailable, not zero. These records live in the memory file and are separate from the desktop run reports described below.

### Read and export a run report

After a run, expand **Run report** below **Activity** in the chat pane. **Recent run** selects a report for the current project. Reports are produced for successful, failed, and cancelled runs, including runs with repository memory off. This makes the ordinary workflow available as a comparison baseline. A process crash that prevents the runtime from sending its final event can also prevent a report from reaching the desktop.

**Copy report** copies the selected report as JSON. **Copy reports** copies the reports retained for the current project. **Delete report** removes the selected report; **Clear reports** removes that project's retained reports. These controls affect reports only; they do not delete chat messages, task handoffs, project notes, or the map cache.

The desktop retains the latest 20 reports per project in its local browser storage. This is a rolling history, so copy the reports needed for a trial before they are displaced. Clearing browser storage also clears this history. If local storage cannot be written, the panel warns you to copy the available reports before closing Span. Reports contain counts and run metadata, without prompts, source text, file paths, or raw error messages. The internal storage key identifies the project; it is not included in the exported report.

| Report information | What it can establish |
| --- | --- |
| Outcome, duration, model requests and responses | Whether the run finished and how much model interaction occurred; errors and cancellations retain the measurements available before stopping |
| Feature settings and settings-change indicator | Which configuration the run used; a run whose settings changed is unsuitable for a comparison that assumes a fixed configuration |
| Map attempts and successful map calls | Whether the agent actually consulted the map; switching it on alone does not demonstrate use |
| Source reads and repeated reads | Successful `fs_read` calls only; searches, command-based reads, and map inspections are excluded. A repeated read can be necessary after an edit |
| Stale-source and unread-source edit rejections | When the typed file tools prevented an edit requiring fresh source evidence |
| Handoff and project-note saves | Recorded memory work, including checkpoint overhead |
| Checkpoint reminders and blocked tool calls | Where the harness requested a handoff or paused ordinary tools |
| Restored context bytes and omitted assistant-history bytes/message counts | Text added and removed while assembling context; these are byte measurements, not token savings |
| Provider usage and its availability | Reported input, output, and total tokens across model responses, including checkpoint turns; missing or incomplete usage remains visible |

Provider usage is labelled **Complete**, **Partial**, or **Unavailable**. Complete means every model request finished successfully and returned valid input and output token counts; zero is a valid count. When a response omits its total but supplies both input and output counts, Span derives that total by adding them. Partial totals contain only known usage and must not be treated as the complete cost of a run. If a stream fails or is cancelled after sending usage, Span retains its latest cumulative usage values instead of adding each cumulative chunk. That request still prevents complete coverage, even if its last usage chunk contains both counts. Unavailable usage is not zero. Cost is included only when every model request returned a valid cost; otherwise cost is unavailable rather than a partial sum. Request and response counts remain useful when a provider does not return usage, but cannot recover missing token totals. Checkpoint reminders and saves are activity counts; the report does not attribute an exact token cost to each checkpoint.

Reports make testing observable; they do not judge whether the task was solved correctly. They also do not change the current checkpoint policy: six successful non-memory tool operations still trigger the existing gate. Use the [trial worksheet](MEMORY_TRIALS.md) to pair reports with task results and continuity checks.

No measured token-savings claim is made by this implementation. Memory adds text and checkpoint work. It can save tokens when a compact handoff replaces enough earlier assistant text or repeated investigation. Keeping every user message also means that memory does not cap total conversation size. Fresh tasks and short conversations may cost more with memory enabled.

Use this evaluation roadmap before choosing a default or claiming savings:

1. **Establish correctness.** Run the repository type checks, tests, and builds. Cover default-off settings migration and persistence; on/off changes during a run; project and session isolation; stale, missing, or escaping evidence; revision conflicts; note supersession; bounded storage and context; checkpoint enforcement; final-answer gating; cancellation; and corrupted-state recovery. Keep tests at the store, runtime, and desktop integration boundaries.

2. **Run matched trials.** Compare four configurations: both off, map only, memory only, and both on. Use the same repository snapshot, model/version, task, approval mode, and success criteria. Run several repetitions. Export each run report and exclude runs whose settings changed from the primary configuration comparison; retain them as diagnostics. Separate first-use cost from later continuation cost, and reset or preserve caches consistently for each comparison. Record provider-reported total input and output tokens across every run, including handoff generation and retries.

3. **Exercise continuity.** Include a multi-step change resumed in the same chat after a restart, another task in the same project, a different project, externally edited or deleted evidence, a cancelled run, and two writers attempting conflicting revisions. Check history with no checkpoint, a changed or truncated prefix, and assistant replies added while memory was off; those uncovered replies must survive compression. Exercise disabling memory alone and an off-then-on change during an active run. Include a user explicitly changing a previous constraint and verify that the recorded reason and final behavior match the request. Compare with the full-history baseline to find useful information lost through assistant-history compression.

4. **Measure quality alongside cost.** Record task success, meaningful tests passed, constraints preserved, incorrect reliance on stale notes, rereads and tool calls, time to completion, checkpoint failures, and provider tokens/cost where reported. Lower token use is not an improvement when the task is incomplete or incorrect. Provider trials are separate from local automated tests; running the latter does not establish model quality or token savings.

5. **Change one policy at a time.** Use the trial results to decide whether ranking, checkpoint frequency, context allocation, or history compression needs adjustment. Add regression cases for demonstrated failures. Keep the default off until repeated trials support both reliable task completion and a useful cost tradeoff. A memory viewer and clearer user control over saved decisions are subsequent product work, not prerequisites already claimed complete.

## Implementation entry points

- `apps/daemon/src/repository-memory/`: schemas, bounded storage, evidence checks, resume context, revisions, handoffs, and metrics.
- `apps/daemon/src/agent-runner.ts`: context injection, assistant-history compression, checkpoint/final gate, usage, and interruption handling.
- `apps/daemon/src/run-diagnostics.ts` and `packages/shared/src/protocol.ts`: counts, provider-usage coverage, and the report contract on terminal run events.
- `apps/desktop/src/renderer/src/run-report/`: bounded local report history, display, copy, and deletion controls.
- `apps/daemon/src/tool-executor.ts` and `fs-tools.ts`: source-read tracking and checked file replacement.
- `apps/daemon/src/runtime.ts` and `config.ts`: embedded runtime preference and optional legacy configuration.
- `apps/desktop/src/main/settings-store.ts`, `main/index.ts`, and `shared/contracts.ts`: persisted preference, validated IPC, and runtime propagation.
- `apps/desktop/src/renderer/src/App.tsx` and `codebase-map/CodebaseMapSettings.tsx`: native Settings → Preferences controls.
