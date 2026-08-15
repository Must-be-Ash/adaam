import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import {
  claimWorkspaceAlertDelivery,
  finishWorkspaceAlertDelivery,
  stageWorkspaceAlertDelivery,
  type WorkspaceAlert,
  type WorkspaceAlertDelivery,
  type WorkspaceAlertStoreClient,
} from "./workspace-alert-store";
import {
  photonAlertAppUrl,
  photonWorkspaceAppUrl,
} from "./photon-mini-app";
import {
  getPhotonWorkspaceState,
  mintPhotonAlertDiscussCapability,
  mintPhotonWorkspaceManager,
  type PhotonWorkspaceStoreClient,
} from "./photon-workspace-store";
import { renderWorkspaceAlertPresentation } from "./workspace-alert-presentation";
import { recordRecentPhotonAlert } from "./photon-alert-reply-store";
import type { WorkspaceMonitor } from "./workspace-monitor-store";

export interface PhotonAlertDeliverySubscription {
  conversationId: string;
  destination: string;
  ownerId: string;
  principalId: string;
  subscriptionId: string;
  threadId: string;
}

export interface PhotonAlertCard {
  discussUrl: string;
  fallbackText: string;
  heading: string;
  manageUrl: string;
}

export class PhotonAlertDeliveryUncertainError extends Error {
  readonly code = "photon_alert_delivery_uncertain";
  constructor(readonly delivery: WorkspaceAlertDelivery) {
    super("Photon alert delivery is uncertain and requires reconciliation.");
    this.name = "PhotonAlertDeliveryUncertainError";
  }
}

export async function deliverWorkspaceAlertToPhoton(input: {
  alert: WorkspaceAlert;
  alertClient?: WorkspaceAlertStoreClient;
  monitor: WorkspaceMonitor;
  now?: Date;
  pauseMonitor: (input: { expectedRevision: number; monitorId: string; now: Date; scope: AuthorizedWorkspaceStoreScope }) => Promise<unknown>;
  recordRecent?: typeof recordRecentPhotonAlert;
  scope: AuthorizedWorkspaceStoreScope;
  send: (card: PhotonAlertCard) => Promise<{ messageId: string }>;
  subscription: PhotonAlertDeliverySubscription;
  workspaceClient?: PhotonWorkspaceStoreClient;
}): Promise<WorkspaceAlertDelivery> {
  const now = input.now ?? new Date();
  if (
    input.alert.ownerId !== input.subscription.ownerId ||
    input.alert.workspaceId !== input.monitor.workspaceId ||
    input.monitor.deliverySubscriptionId !== input.subscription.subscriptionId
  ) throw new Error("photon_alert_subscription_scope_mismatch");
  const staged = await stageWorkspaceAlertDelivery({
    alert: input.alert,
    destination: input.subscription.destination,
    now,
    scope: input.scope,
    subscriptionId: input.subscription.subscriptionId,
  }, input.alertClient);
  const claim = await claimWorkspaceAlertDelivery({
    deliveryId: staged.deliveryId,
    now,
    scope: input.scope,
  }, input.alertClient);
  if (!claim.claimed) return claim.delivery;
  const delivering = claim.delivery;
  let card: PhotonAlertCard;
  let deliveredWorkspaceName = input.alert.workspaceName;
  try {
    const workspaceState = await getPhotonWorkspaceState({
      principalId: input.subscription.principalId,
      threadId: input.subscription.threadId,
    }, input.workspaceClient);
    const workspace = workspaceState.workspaces.find(
      (candidate) => candidate.id === input.alert.workspaceId && candidate.status === "active",
    );
    if (!workspace) throw new Error("photon_alert_workspace_unavailable");
    deliveredWorkspaceName = workspace.name;
    const discuss = await mintPhotonAlertDiscussCapability({
      alertId: input.alert.alertId,
      conversationId: input.subscription.conversationId,
      expectedRevision: workspaceState.revision,
      findingId: input.alert.findingId,
      ownerId: input.subscription.ownerId,
      principalId: input.subscription.principalId,
      threadId: input.subscription.threadId,
      workspaceId: input.alert.workspaceId,
    }, input.workspaceClient);
    const manager = await mintPhotonWorkspaceManager({
      principalId: input.subscription.principalId,
      threadId: input.subscription.threadId,
    }, input.workspaceClient);
    const presentationAlert = {
      ...input.alert,
      workspaceName: workspace.name,
    };
    const presentation = renderWorkspaceAlertPresentation(presentationAlert);
    card = {
      discussUrl: photonAlertAppUrl(
        discuss.alertToken,
        manager.managerToken,
      ),
      fallbackText: presentation.fallbackText,
      heading: presentation.heading,
      manageUrl: photonWorkspaceAppUrl(manager.managerToken),
    };
  } catch (error) {
    await finishWorkspaceAlertDelivery({
      deliveryId: delivering.deliveryId,
      failureCode: "photon_delivery_preparation_failed",
      now,
      outcome: "retryable_failure",
      scope: input.scope,
    }, input.alertClient);
    throw error;
  }
  let messageId: string;
  try {
    ({ messageId } = await input.send(card));
  } catch {
    const uncertain = await finishWorkspaceAlertDelivery({
      deliveryId: delivering.deliveryId,
      failureCode: "photon_acceptance_unknown",
      now,
      outcome: "delivery_uncertain",
      scope: input.scope,
    }, input.alertClient);
    await input.pauseMonitor({
      expectedRevision: input.monitor.configurationRevision,
      monitorId: input.monitor.monitorId,
      now,
      scope: input.scope,
    });
    throw new PhotonAlertDeliveryUncertainError(uncertain);
  }
  const delivered = await finishWorkspaceAlertDelivery({
    deliveryId: delivering.deliveryId,
    now,
    outcome: "delivered",
    scope: input.scope,
  }, input.alertClient);
  await (input.recordRecent ?? recordRecentPhotonAlert)({
    candidate: {
      alertId: input.alert.alertId,
      deliveredAt: now.toISOString(),
      deliveryMessageId: messageId,
      title: input.alert.title,
      workspaceId: input.alert.workspaceId,
      workspaceName: deliveredWorkspaceName,
    },
    conversationId: input.subscription.conversationId,
  });
  return delivered;
}
