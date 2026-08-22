# Congressional monitor retry defect

Observed on 2026-08-20: when the official House disclosure ZIP could not be
acquired, the Congressional Signals worker returned explanatory prose but did
not commit a deterministic terminal outcome or checkpoint. The scheduler then
treated the same occurrence as unfinished and dispatched it five times before
the monitor auto-paused, causing repeated model spend for one scheduled window.

Future repair: make a deterministic source-acquisition failure terminalize the
occurrence exactly once (with an explicit failed/uncertain outcome), while
preserving genuine retry behavior for infrastructure interruptions that have
not produced a worker outcome. Prove one occurrence, no duplicate paid worker
runs, and a paused or correctly advanced monitor state as appropriate.

Until repaired, keep the affected Congressional monitor paused and
non-dispatchable.
