# Workspace Runtimes and Strategy Packs

This document summarizes the application delivered by Specs 1 and 2.

## Application

Eve is a single agent service that manages multiple durable, isolated workspaces. Each workspace has its own conversation state, instructions, capabilities, budgets, scheduled monitors, findings, alerts, and strategy configuration. Owners interact with the same underlying state through natural-language conversations in Photon and management controls in Spectrum.

## Features

- Create, select, archive, restore, and inspect independent workspaces.
- Run scheduled monitors without requiring the workspace to remain selected.
- Store structured findings and deliver workspace-labeled Photon alerts.
- Select the relevant workspace from an alert and continue the discussion with bounded alert context.
- View monitor schedules, approved sources, usage, limits, failures, and health in Spectrum.
- Install repository-owned, versioned strategy packs with validated manifests and pinned content digests.
- Configure, upgrade, downgrade, replace, or remove packs without deleting historical findings or owner-created resources.
- Use `IPO Filings@1.0.0` to monitor approved SEC filings through the existing normalized finding and alert pipeline.
- Use the same authenticated application services from Eve tools and Spectrum actions.

## Agent capabilities

- Create a pack-bound workspace from a concrete request such as: `Create an IPO-filings session at 9 AM and 4 PM.`
- Install a pack without starting background work until a schedule is explicitly enabled.
- Explain a workspace's active strategy, configuration, sources, schedule, limits, usage, and health.
- Apply only the selected workspace's instructions and pack context to interactive turns.
- Run workers with an exact workspace, generation, strategy-pack, capability, source, and monitor snapshot.
- Detect qualifying events, record findings, deliver alerts, and route follow-up discussion to the correct workspace.
- Safely pause or retire pack-managed work while preserving durable research and conversation state.

## Engineering properties

- Owner-authorized ingress and workspace mutations fail closed when identity, configuration, or storage requirements are incomplete.
- Workspace and pack data remain isolated across interactive sessions, scheduled workers, findings, and alerts.
- Pack requests cannot grant capabilities; effective access is always constrained by deployment, owner, workspace, monitor, and source policy.
- Mutations and deliveries are atomic or recoverable, revision-checked, replay-safe, and idempotent.
- Pack versions, source contracts, and runtime snapshots are digest-bound and revalidated before access and commit.
- Budget, concurrency, privacy, and bounded-data rules are enforced at runtime boundaries.
- Crash recovery, stale-work reconciliation, and concurrent execution preserve durable state without duplicating effects.
- Independent feature controls support staged rollout and rollback without deleting bindings, findings, alerts, or receipts.
- Memory, Redis, compiled-worker, browser, and production acceptance tests cover the complete owner workflow.
