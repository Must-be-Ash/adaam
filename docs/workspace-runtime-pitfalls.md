# Workspace runtime pitfalls

Failure modes that have already cost real money or real debugging time in this
repository, with the evidence that settled each one. Read this before debugging
a monitor occurrence. Every entry here was learned the expensive way at least
once; several were learned twice.

## Diagnosis

**Do not act on a code-read hypothesis by buying a production occurrence.**
The cheapest correct move is to make the failure describe itself in durable
state, then run once and read the fact. Five occurrences were spent in one
night guessing at a cause that the alert store could have answered for free.

**`vercel logs` is not a reliable diagnostic channel.** The window is roughly
50 distinct rows on a rolling buffer. Polling `/eve/v1/photon-workspaces/state`
while an occurrence runs puts your own requests into that window and evicts the
rows you are looking for - 14 of 50 rows in one capture were self-inflicted.
Stay off `/state` during a run, or read the durable monitor record instead.

**`vercel logs --json` emits every row twice.** Deduplicate by `id` before
counting anything. A claim of "two worker sessions ran" was wrong for exactly
this reason.

**Read the store, not the code, when the store knows.** Alert records,
delivery records, and monitor records are queryable read-only with the
`KV_REST_API_*` credentials. `alertId === alert_${sha256(findingId)}` tells you
in one query whether an alert was ever reachable by delivery.

**A gateway credit balance of zero surfaces as `empty model response;
reissuing the model call once`.** It is not model flakiness. Check the balance
before blaming code - the real error only appears deeper in the tool-loop logs
as `GatewayInternalServerError: A positive credit balance is required`.

## Scheduling

**Resuming a paused monitor reuses its existing interval anchor.** Once a
monitor has run, it no longer qualifies for the immediate-occurrence path, so a
resume does not fire "now": the sweeper finds the old anchor outside its
recovery window, records `missed_occurrences_skipped`, and advances a full
cadence - twelve hours, silently. Always set a fresh future anchor, then assert
`nextOccurrenceAt > now` from the response before believing the monitor is
armed. Reporting "armed for 10:02" from a resume response without re-reading
the record cost a full night's test window.

## Sources and cursors

**The public-source cursor is owner-scoped by `sourceId` and survives workspace
deletion.** Deleting and recreating a workspace does not reset it. What replays
a backlog is the new per-workspace *subscription*, which starts behind the
shared cursor.

**Acquisition advances the cursor even when the occurrence later fails.** A
dropped alert is dropped permanently: the statement is consumed, the finding is
committed, and nothing re-examines it. Treat any post-acquisition failure as
data loss, not a retryable blip.

**Rebuilding a workspace repeatedly inflates the replay set.** Each failed run
advances the cursor, so every fresh subscription has more to replay than the
last. Backlog outgrew the classifier's `maximumInputTokens` after enough
rebuilds in one night, turning a working configuration into
`SESSION_TOKEN_LIMIT_REACHED`.

## Alerts

**A keyed alert cannot be found by delivery.** `stageWorkspaceAlert` writes
under `digest(findingId\0presentationKey)`, but `readWorkspaceAlert` computes
`digest(findingId)`. Keying every presentation made every commentary alert
undeliverable: the occurrence committed its finding and died as
`workspace_alert_unavailable`. Stage the first presentation unkeyed. Inverse
Cramer was unaffected only because it stages no presentations at all, which is
why one vertical worked for months while another never did once.

**`input.alertPresentations ?? [null]` lets `[]` through.** An empty array
means the staging loop runs zero times and commits a finding with no alert -
inside a branch already guarded by `if (outcome.finding)`. An empty list is not
"no alert"; it means the caller had no presentation to offer.

**`finding.summary` is the alert's fallback `whyMatched`.** `alertSchema` caps
`whyMatched` at 1,000 characters while a finding's summary may be 2,000. A
summary sized to its own limit parses fine as a finding and then throws at
alert staging. Bound any summary by the ALERT cap. Also: whatever goes in that
field reaches a human, so a join of finding identities is not an acceptable
summary.

## Testing

**Test the seam, not just the units.** `accept-earnings-call-photon-alert.ts`
builds a `WorkspaceAlert` literal in memory and hands it straight to
`deliverWorkspaceAlertToPhoton`, so it never exercises the `readWorkspaceAlert`
lookup. Its blind spot was exactly where alerts were being lost, which is how
the bug shipped green and stayed green. `verify:workspace-runtime:alert-dispatch`
covers commit -> store -> read -> deliver as one path.

**A rule copied into two call sites will drift.** The unkeyed-first rule lived
in two commit paths by copy-paste. Guard the structure (one definition, N
callers), not the number of copies.

## Contracts and limits

**Job `limits` are digest-covered.** Changing `maximumInputTokens` or any
sibling changes the contract digest, which re-versions the evidence contract
AND every pack that pins it. It is never a one-line change.

**A failed occurrence does not reconcile its reservation.** The parent
`scheduled_monitor` hold stays charged against the day. Enough failures
exhaust a daily ceiling with almost no actual spend, so always report reserved
separately from actual.
