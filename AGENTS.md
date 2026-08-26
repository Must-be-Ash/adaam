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
