# Repository memory trial worksheet

Use this worksheet when the test materials are ready. It compares task quality and continuity alongside token use. It contains no measured results. The [end-to-end process](REPOSITORY_MEMORY.md) explains the memory rules and run reports.

## Prepare one task

Choose a real task with a clear result and at least one meaningful verification step. Write the success criteria before the first run. Keep task text, starting code, model and provider choices, approval mode, and instructions the same across conditions. Record anything that cannot be held constant.

| Trial detail | Fill in before running |
| --- | --- |
| Task ID and short description | |
| Starting repository revision and any necessary uncommitted changes | |
| Exact task instructions, stored separately from run-report exports | |
| Model/version and provider configuration | |
| Approval mode and relevant tool permissions | |
| Required behavior | |
| Constraints that must survive a restart | |
| Verification commands or manual checks | |
| Planned pause/restart point | |
| Pass criteria after resuming | |
| Number of repetitions and condition order | |

Use isolated trial copies of the project. A new chat does not reset project notes or the map cache. Record whether each condition starts with empty or previously populated memory and caches, and make that choice consistent across repetitions. Do not clear memory for ongoing work merely to obtain a cold trial. Keep each trial's project location stable between its first run and its continuation, because moving a project changes its memory identity.

## Compare four configurations

Set both switches in **Settings → Preferences** before starting a run. Keep them unchanged throughout that trial.

| Condition | Use codebase mapping | Use repository memory | Purpose |
| --- | --- | --- | --- |
| Baseline | Off | Off | Measure the ordinary workflow |
| Map only | On | Off | Isolate structural navigation |
| Memory only | Off | On | Isolate saved handoffs, notes, and memory enforcement |
| Map and memory | On | On | Measure their combined behavior |

Treat first-use and continuation results separately. First use may include indexing and initial handoff work; a resumed task may benefit from that work. Rotate the condition order across repetitions if practical. An enabled map with zero successful map calls has not demonstrated the benefit of map use.

## Collect each run

1. Start from the recorded project state and send the same task instructions. Record the condition and whether its cache/memory is fresh or warm.
2. At the planned pause, record the actual state of the task. For a restart trial, close and reopen Span, select the same project and chat, and send the same continuation instruction used in the other conditions.
3. For every completed, failed, or cancelled run, expand **Run report** below **Activity**. Select **Recent run**, then use **Copy report** to save its JSON with the task materials. **Copy reports** copies the project's retained reports together. Copy them before the rolling 20-report history displaces them.
4. Record task quality manually using the checks below. Keep the run report and quality assessment together using the report's run ID.
5. If the report says settings changed during the run, exclude it from the primary configuration comparison and repeat that condition. Keep the changed-settings report as a diagnostic result. Do not omit other failures merely because they cost more or did not complete.

If a process crash prevents a report, record that as missing data. A failed or cancelled run's available counters are still useful; they do not represent the cost of completing the task. Include follow-up runs required to finish when computing task-level cost.

| Observation | Fill in after each run or continuation |
| --- | --- |
| Task ID, repetition, condition, and run ID(s) | |
| Fresh or warm map/memory; first use or continuation | |
| Run outcome and any missing report | |
| Settings changed? If yes, reason and replacement trial | |
| Required behavior achieved? Evidence | |
| Verification checks passed/failed/not run | |
| Original constraints preserved? Evidence | |
| Resume restored the right objective and next step? | |
| Agent repeated completed work or missed unfinished work? | |
| Agent relied on stale information? What happened? | |
| Human corrections or interventions required | |
| Checkpoints disrupted progress or caused extra retries? | |
| Provider usage availability: complete/partial/unavailable | |
| Full task tokens/cost, only where reported completely | |
| Time to a verified result, including continuation and retries | |
| Other differences that weaken the comparison | |

## Check continuity and enforcement

Include these cases among the materials, with a baseline comparison where applicable:

- Resume a multi-step task in the same chat after restarting Span. Check the objective, constraints, completed work, and next steps against what actually happened.
- Change or delete a file referenced by saved memory between runs. Check that code claims with stale evidence are withheld and that a relevant edit requires a current source read.
- Cancel after some tool work, then continue. Check that the agent recognizes unfinished work and verifies its state before claiming success.
- Explicitly change a previous user constraint. Check that the new behavior follows the request and the handoff records why the constraint changed.
- Continue after assistant replies written while memory was off. Check that uncovered replies remain available and useful context is not lost through compression.
- Start a different chat in the same project, then a chat in a different project. Check that task handoffs stay with their chat and project notes do not cross project boundaries.

Test settings changes during an active run separately from the four fixed-configuration comparisons. A report flagged for changed settings can verify this behavior, but cannot establish the cost of a stable mode.

## Interpret the results

Judge correctness first. Lower token use is not an improvement if a condition fails its required behavior, loses constraints, or needs more human repair. Keep errors and cancellations in the results, with their recovery cost where available.

A report's restored-context and omitted-history values measure UTF-8 bytes. They do not measure tokenizer output, provider cache billing, repeated text across later model turns, or net savings. Source-read counts cover successful file-read tool calls only; searches, commands, and map inspections are excluded. Repeated source reads can be justified after edits. Blocked edits and checkpoints can show that enforcement worked; their counts alone do not establish better task quality.

Provider usage is complete only when every model request finishes successfully and supplies valid input and output counts. A missing response total is derived from input plus output when both counts are available. Partial totals are the known portion, and unavailable usage is not zero. After a stream fails or is cancelled, its latest cumulative usage is retained without adding repeated cumulative chunks; coverage remains partial even if that request supplied both counts. Compare full task token totals only when all constituent runs have complete usage. Cost is shown only when every model request reports a valid cost; otherwise it is unavailable, not a partial cost sum. Do not infer missing cost from tokens alone.

Checkpoint writing and reminder turns are part of the measured run. Add all runs needed to reach the verified task result, including retries and continuation. Report first-use and later-use costs separately before drawing a combined conclusion.

After several matched repetitions, use demonstrated failures to choose one change to test next: checkpoint frequency, note selection, context budget, or history compression. Keep the current six-successful-tool checkpoint policy as the control until the results support a change. Do not claim savings from the report counters alone.
