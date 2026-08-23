import { sendPhotonWorkspaceAlertCard } from "./photon-alert-outbound";
import {
  deliverWorkspaceAlertToPhoton,
  type PhotonAlertCard,
} from "./photon-alert-delivery";
import { readPhotonAlertDeliverySubscription } from "./photon-alert-subscription-store";
import { readWorkspaceAlert, type WorkspaceAlertStoreClient } from "./workspace-alert-store";
import { pauseWorkspaceMonitorAfterUncertainAlert } from "./workspace-monitor-store";
import type { ClaimedWorkspaceMonitor } from "./workspace-monitor-store";
import type { WorkspaceRunOutcome } from "./workspace-finding-store";

/*
 * The seam between committing an outcome and delivering its alert had no test:
 * the acceptance harness builds a `WorkspaceAlert` literal and calls
 * `deliverWorkspaceAlertToPhoton` directly, so it never exercises the
 * `readWorkspaceAlert` lookup below - which is exactly where alerts were being
 * lost. These injection points exist so that lookup can be covered against a
 * store the commit path wrote.
 */
export interface WorkspaceAlertDispatchClients {
  readonly alert?: WorkspaceAlertStoreClient;
  readonly deliver?: typeof deliverWorkspaceAlertToPhoton;
  readonly readSubscription?: typeof readPhotonAlertDeliverySubscription;
  readonly send?: (card: PhotonAlertCard, destination: string) => Promise<unknown>;
}

export async function deliverWorkspaceOutcomeToPhoton(input: {
  clients?: WorkspaceAlertDispatchClients;
  job: ClaimedWorkspaceMonitor;
  outcome: WorkspaceRunOutcome;
}): Promise<void> {
  const finding = input.outcome.finding;
  if (!finding) return;
  const alert = await readWorkspaceAlert(
    input.job.scope,
    finding.findingId,
    input.clients?.alert,
  );
  if (!alert) throw new Error("workspace_alert_unavailable");
  const readSubscription =
    input.clients?.readSubscription ?? readPhotonAlertDeliverySubscription;
  const subscription = await readSubscription({
    ownerId: input.job.scope.ownerId,
    subscriptionId: input.job.monitor.deliverySubscriptionId,
  });
  const send = input.clients?.send;
  await (input.clients?.deliver ?? deliverWorkspaceAlertToPhoton)({
    alert,
    monitor: input.job.monitor,
    pauseMonitor: pauseWorkspaceMonitorAfterUncertainAlert,
    scope: input.job.scope,
    send: (card: PhotonAlertCard) => send
      ? send(card, subscription.destination) as ReturnType<
        typeof sendPhotonWorkspaceAlertCard
      >
      : sendPhotonWorkspaceAlertCard({ card, destination: subscription.destination }),
    subscription,
  });
}
