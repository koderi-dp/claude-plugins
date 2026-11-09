# Watchdog signals

Check with `{ "action": "signals" }`: it answers only the open signals from the mod (or `no signals`; with a PR merged by hand it answers `{ signals, mergedPending }`, and those items get their Close, step 9), and `get` carries them too; each is delivered once, so act in the turn you read it and name it in the line. A wake-up from the mod asks for exactly this call.

- **silent** (no step for `limits.silentMinutes`): once, send the agent a request for a report; no answer by the next check → stop it (`TaskStop`), `close` the dispatch with `result: "stopped: silent"`, dispatch again from the surviving tree.
- **dead** (the session restarted with agents running): the signal names them; read `resume.md` and re-dispatch from the surviving working tree, never from `lastVerified` alone.
- **looping** (the same failing command three times, or fix rounds over `limits.fixRounds`): stop the agent, then one `fix` brief with `"escalate": true` and the failures as findings; a second failure → Stop conditions.
- **budget** (`limits.taskMinutes` or `limits.itemTokens`): finish the running task, then Stop conditions.

Between items under `run all`, schedule a wake-up every `limits.silentMinutes` (`send_later` or the host's equivalent) so a silent agent is noticed without a user turn; the mod schedules one itself while a subagent or a child session runs, where the host offers `ScheduleWakeup`.
