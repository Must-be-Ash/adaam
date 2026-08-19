# eve Agent App

Read `HANDOFF.md` first. It is the canonical guide to Eve's current product
direction, implemented architecture, safety invariants, operational workflow,
known gaps, and production lessons.

## Scope control and repair boundaries

Treat the user's requested outcome as the scope contract. Before editing, state
the smallest user-visible outcome, the relevant existing path to reuse, and the
stop condition. Do not turn a focused request or bug fix into a new framework,
generalized platform, second product path, broad hardening pass, or cleanup
sweep unless the user explicitly approves that expansion.

Fix a newly discovered defect without asking only when it is critical to the
requested path: it blocks the requested acceptance flow, is a regression caused
by the current change, or creates a material security, privacy, data-loss,
unauthorized-spend, or unintended-external-action risk. Make the smallest safe
root-cause fix and add the narrowest useful regression proof. Report other
defects or improvements as follow-ups; do not implement them in the current
task.

Stop and ask before adding a new connector, persistent store, schema family,
authentication protocol, background job, production endpoint, migration,
model route, or reusable abstraction that is not strictly required by the
requested outcome. The same applies when a small change starts spreading across
unrelated subsystems or materially increases cost or delivery time.

For live or paid debugging, run one controlled attempt per concrete hypothesis.
After an unexpected failure, pause the affected monitor or side effect before
trying again, reproduce locally or with deterministic fixtures when practical,
and do not repeat paid attempts without new evidence. Report actual provider
spend separately from reserved or worst-case budget accounting.

Finishing means leaving the requested path complete and the system safe. Before
stopping, remove temporary routes and secrets, pause accidental schedules,
restore flags as appropriate, preserve a clean recovery commit, and report the
exact remaining blocker and smallest next step. Once the requested outcome and
its focused verification pass, stop; do not chase every issue discovered along
the way.

Acceptance-only production surfaces must be ephemeral and narrowly gated. Do
not commit hard-coded production record identifiers or long-lived test routes
to the default branch. If an exceptional live probe is necessary, obtain the
needed approval, bound its cost and effects, and remove the probe and its secret
in the same operation before starting other work.

Keep verification proportional: use focused tests while implementing, then one
relevant regression gate and one controlled end-to-end acceptance when needed.
Do not restart broad audits, reviewer fleets, full historical validation, or
paid acceptance loops after every small repair unless the changed risk surface
actually requires them or the user explicitly requests them.

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
