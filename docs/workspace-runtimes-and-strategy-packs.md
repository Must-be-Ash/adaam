# Eve Foundation: Workspaces, Strategy Packs, and Public Sources

This document summarizes the reusable application foundation delivered by Specs
1–3. It intentionally excludes the specialized strategies introduced by later
specifications.

## Application model

Eve is a forkable, single-owner agent service with one user-facing identity and
many durable, isolated workspaces. Each workspace can act like a specialized
agent because it owns its own conversation state, strategy, instructions,
permissions, budgets, monitors, findings, and alerts.

The model is not kept running continuously. Schedules and source events start
short-lived, bounded workers only when work is due. Each worker receives the
exact context and tools for one workspace and exits after recording its result.

Photon/iMessage is the first interface, but the workspace, strategy, source, and
worker contracts are channel-neutral. Telegram or web support requires a channel
adapter, not a second agent platform.

## What a fork includes

### Independent workspaces

- Create, select, rename, archive, restore, and start fresh in named workspaces.
- Keep conversation history, durable research, files, settings, monitors,
  budgets, and tool permissions isolated per workspace.
- Run several background strategies concurrently without selecting them in chat.
- Route every ordinary message to exactly one workspace before a model sees it.
- Preserve durable research and monitors when interactive chat history is reset.

### Background monitoring and alerts

- Create and manage scheduled monitors through natural language and Spectrum.
- Wake bounded workers only for due occurrences instead of keeping models alive.
- Record structured findings and safely advance source checkpoints.
- Deliver workspace-labeled alerts into the owner's existing conversation.
- Use **Discuss** to select the producing workspace and give the next turn a
  one-time bounded alert reference.
- Detect strong plain-text references to recent alerts without reading or merging
  workspace histories; ambiguous messages stay in the selected workspace.
- Inspect schedules, sources, next and previous runs, failures, budgets, usage,
  active workers, and health in the Spectrum manager.

### Versioned strategy packs

- Package a reusable strategy as a validated, repository-owned manifest,
  instructions, source contracts, tools, configuration, managed monitors, and
  evaluations.
- Generate a deterministic catalog with immutable versions and content digests.
- Create a pack-bound workspace from a request such as: `Create an IPO Filings
  session at 9 AM and 4 PM.`
- Install a pack without starting background work until the owner enables its
  managed monitor.
- Configure, upgrade, downgrade, replace, or remove a pack through the same
  authenticated application service used by Eve and Spectrum.
- Preserve findings, alerts, checkpoints, and owner-created resources when a
  managed pack is removed.
- Bind each worker to the exact workspace generation, pack version and digest,
  capabilities, source contracts, monitor, and configuration that produced it.

### Reusable public-source adapters

- Register reviewed, versioned adapters for official public sources.
- Acquire a public source once and reuse its canonical facts across authorized
  workspaces instead of fetching the same data independently for every agent.
- Keep canonical facts immutable, provenance-bearing, and separate from each
  workspace's private interpretation and findings.
- Give each workspace an authorized projection and independent checkpoint so one
  workspace cannot inspect another workspace's subscriptions or conclusions.
- Record source revisions, corrections, replay identity, acquisition health, and
  bounded failure states without exposing raw payloads in logs.
- Enforce allowed origins, redirects, response types, byte limits, timeouts, and
  source-specific parsing before facts enter a strategy.
- Include reference adapters for official SEC filing data and House financial
  disclosure indexes/PTR documents, with explicit partial or unsupported states
  when a document cannot be safely extracted.

## What Eve can do with this foundation

- Turn an owner request into a named, configured workspace using an available
  strategy pack.
- Keep an eye on approved sources at a chosen schedule and report matching
  events without additional code for each installation.
- Explain a workspace's strategy, configuration, sources, schedule, limits,
  usage, findings, and health.
- Run multiple strategies against shared public facts while keeping their
  histories, settings, interpretations, and alerts separate.
- Continue a conversation about an alert in the correct workspace without
  copying another workspace's history into it.
- Pause or retire managed work while retaining durable research and audit state.

Creating a genuinely new research method or supporting a new source family can
still require a reviewed strategy pack or source adapter. The foundation removes
the need to rebuild scheduling, isolation, routing, storage, alert delivery,
provenance, and lifecycle management for every new strategy.

## Engineering qualities

- Single-owner authorization fails closed when identity, configuration, or
  storage is incomplete.
- Workspace context and durable state remain isolated across interactive turns,
  workers, findings, and alerts.
- Capabilities are default-deny and cannot be expanded by pack instructions or
  model output.
- Mutations, worker commits, source acquisitions, and alert deliveries use
  revision checks, replay protection, stable identities, and bounded records.
- Pack content, source contracts, and runtime snapshots are digest-bound and
  revalidated before access and commit.
- Budgets, concurrency, source boundaries, and log privacy are enforced outside
  the model.
- Independent flags support staged rollout and rollback without deleting durable
  workspaces, bindings, findings, facts, alerts, or receipts.
- Fixture, in-memory, Redis, compiled-worker, application-build, and controlled
  production acceptance cover the foundation's main owner workflows.

For the user-facing routing model, see
[`docs/workspace-agent-routing-and-ux.md`](workspace-agent-routing-and-ux.md).
