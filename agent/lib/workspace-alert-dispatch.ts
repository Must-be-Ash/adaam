import { sendPhotonWorkspaceAlertCard } from "./photon-alert-outbound";
import {
  deliverWorkspaceAlertToPhoton,
  type PhotonAlertCard,
} from "./photon-alert-delivery";
import { readPhotonAlertDeliverySubscription } from "./photon-alert-subscription-store";
import { readWorkspaceAlert } from "./workspace-alert-store";
import { pauseWorkspaceMonitorAfterUncertainAlert } from "./workspace-monitor-store";
import type { ClaimedWorkspaceMonitor } from "./workspace-monitor-store";
import type { WorkspaceRunOutcome } from "./workspace-finding-store";

export async function deliverWorkspaceOutcomeToPhoton(input: {
  job: ClaimedWorkspaceMonitor;
  outcome: WorkspaceRunOutcome;
}): Promise<void> {
  const finding = input.outcome.finding;
  if (!finding) return;
  const alert = await readWorkspaceAlert(input.job.scope, finding.findingId);
  if (!alert) throw new Error("workspace_alert_unavailable");
  const subscription = await readPhotonAlertDeliverySubscription({
    ownerId: input.job.scope.ownerId,
    subscriptionId: input.job.monitor.deliverySubscriptionId,
  });
  await deliverWorkspaceAlertToPhoton({
    alert,
    monitor: input.job.monitor,
    pauseMonitor: pauseWorkspaceMonitorAfterUncertainAlert,
    scope: input.job.scope,
    send: (card: PhotonAlertCard) => sendPhotonWorkspaceAlertCard({
      card,
      destination: subscription.destination,
    }),
    subscription,
  });
}
