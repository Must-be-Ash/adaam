import {
  ensurePublicSourceSubscription,
  type PublicSourceSubscriptionStoreClient,
} from "./public-source-subscription-store";
import {
  createPublicSourceSubscription,
  resolvePublicSourceWorkspaceReference,
} from "./public-source-workspace-reference";
import { SEC_IPO_SOURCE_ID } from "./sec-ipo-reference";
import {
  getWorkspaceMonitor,
  migrateWorkspaceMonitorPublicSourceSubscriptions,
  type WorkspaceMonitor,
  type WorkspaceMonitorStoreClient,
} from "./workspace-monitor-store";
import {
  readWorkspaceDocument,
  writeWorkspaceStrategyBinding,
  type WorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "./workspace-state-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import type { PublicSourceSubscription } from "./public-source-adapter-schema";

export interface SecPublicSourceWorkspaceMigration {
  readonly monitor: WorkspaceMonitor;
  readonly strategy: WorkspaceDocument<"strategy"> | null;
  readonly subscription: PublicSourceSubscription;
}

export async function migrateSecPublicSourceWorkspace(input: {
  readonly monitor?: WorkspaceMonitor;
  readonly monitorId: string;
  readonly now?: Date;
  readonly scope: AuthorizedWorkspaceStoreScope;
}, clients: {
  readonly monitor?: WorkspaceMonitorStoreClient;
  readonly state?: WorkspaceStateStoreClient;
  readonly subscription?: PublicSourceSubscriptionStoreClient;
} = {}): Promise<SecPublicSourceWorkspaceMigration> {
  const currentMonitor = input.monitor ?? await getWorkspaceMonitor(
    input.scope,
    input.monitorId,
    clients.monitor,
  );
  if (
    !currentMonitor ||
    currentMonitor.monitorId !== input.monitorId ||
    currentMonitor.ownerId !== input.scope.ownerId ||
    currentMonitor.workspaceId !== input.scope.workspaceId ||
    currentMonitor.sources.length !== 1 ||
    currentMonitor.sources[0]?.sourceId !== SEC_IPO_SOURCE_ID
  ) {
    throw new Error("sec_public_source_migration_invalid");
  }
  const reference = resolvePublicSourceWorkspaceReference({
    monitorId: currentMonitor.monitorId,
    sourceId: SEC_IPO_SOURCE_ID,
    workspaceId: input.scope.workspaceId,
  });
  const monitor = await migrateWorkspaceMonitorPublicSourceSubscriptions({
    monitorId: currentMonitor.monitorId,
    now: input.now,
    publicSourceSubscriptions: [reference],
    scope: input.scope,
  }, clients.monitor);

  let strategy = await readWorkspaceDocument("strategy", input.scope, clients.state);
  if (strategy?.schemaVersion === 2) {
    const managedEntry = Object.entries(strategy.value.managedResources).find(
      ([, resource]) => resource.monitorId === monitor.monitorId,
    );
    if (managedEntry) {
      const [resourceId, resource] = managedEntry;
      const existing = resource.publicSourceSubscriptions;
      if (JSON.stringify(existing) !== JSON.stringify([reference])) {
        strategy = await writeWorkspaceStrategyBinding({
          expectedRevision: strategy.revision,
          now: input.now,
          scope: input.scope,
          value: {
            ...strategy.value,
            managedResources: {
              ...strategy.value.managedResources,
              [resourceId]: {
                ...resource,
                publicSourceSubscriptions: [reference],
              },
            },
          },
        }, clients.state);
      }
    }
  }
  const managedBy = monitor.managedBy;
  const subscription = await ensurePublicSourceSubscription(
    input.scope,
    createPublicSourceSubscription({
      binding: managedBy
        ? {
            bindingRevision: managedBy.bindingRevision,
            packContentDigest: managedBy.packContentDigest,
            packId: managedBy.packId,
            packVersion: managedBy.packVersion,
          }
        : null,
      lifecycleState: monitor.lifecycleState === "enabled" ? "active" : "paused",
      monitorId: monitor.monitorId,
      reference,
      workspaceId: input.scope.workspaceId,
    }),
    clients.subscription,
  );
  return Object.freeze({ monitor, strategy, subscription });
}
