# eve Agent App

**The code is the source of truth for how Eve currently behaves.** Verify every
behavioral claim against it before acting.

## Scope discipline

Make the smallest change that completes the requested user-visible outcome and
reuse existing plumbing. Fix critical blockers, regressions, and security,
privacy, data-loss, spend, or external-action risks; report unrelated issues
without expanding the task. Ask before adding new architecture or materially
increasing scope, cost, or time. Keep paid debugging and verification focused,
distinguish reserved budget from actual spend, and stop once the path works.
Before finishing, leave the system safe and complete: pause unintended work and
remove any temporary routes, secrets, or test state created by the task.

## Congressional Signals finish-line authorization

The owner has approved completing Congressional Signals, including the source
progress and baseline changes described below. This is within the authorized
scope: do not ask again for approval of this design or for each verified PR.
Implement, test, and merge fixes when supported by evidence; do not expand this
authorization to unrelated strategies or infrastructure.

- Let independently validated, complete filings proceed without waiting for
  unrelated unresolved filings in the yearly House archive. Keep unresolved
  filings durably queued and visible as coverage gaps; never mark them complete
  or use their unverified rows for research or alerts.
- Preserve per-filing atomicity, ordered delivery, corrections, retractions,
  and idempotent replay. Establish a durable initial-baseline boundary so late
  recovery of historical filings cannot send historical alerts, while genuinely
  new filings can proceed. Incomplete coverage must still prevent conclusions
  that require complete history.
- Reuse the existing acquisition journal, pending queue, subscriptions,
  acknowledgements, coverage tracking, and budget plumbing. Do not reset source
  cursors, erase pending work, weaken evidence validation, or increase budgets
  or recovery limits to make acceptance appear successful.
- Retain the working models: `anthropic/claude-haiku-4.5` for House extraction,
  `google/gemini-3-flash` for independent OCR, and `openai/gpt-5.4` for
  Congressional research. The owner has explicitly dropped the ZAI migration.
  Do not change global model routes or run further model comparisons for this
  task.
- Track the remaining issues sequentially. Preserve the owner's watchlist,
  workspace isolation, schedule, and budget. Require bounded production
  acceptance, reconciled costs, and a durable outcome/checkpoint before enabling
  the normal monitor. Leave it safely paused if acceptance fails.
- Use backend operations when possible. If UI interaction is necessary, stop
  and ask the owner to perform it. This authorization does not permit trades,
  manual test messages, or unrelated external actions.

The product goal remains `docs/notes/GOAL.md`. The source-progress proposal and
older finish-line reviews provide context, but code and the authorization above
take precedence over their stale findings or requests for approval.

This project uses the eve framework. Before writing code, read the relevant guide
from the installed eve package docs. In most installs, those docs are at
`node_modules/eve/docs/`. In workspaces or local package installs, resolve the
installed `eve` package location first and read its `docs/` directory. If
package docs are unavailable, use https://eve.dev/docs as a fallback.

Before implementing an integration yourself, use
`eve registry search <query>` or `eve registry list` to discover available
integrations. Inspect one with `eve registry view <item>`, then install it with
`eve add <item>`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
