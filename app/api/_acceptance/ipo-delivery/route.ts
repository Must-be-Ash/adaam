import { createHash, timingSafeEqual } from "node:crypto";

import { deliverWorkspaceAlertToPhoton } from "@/agent/lib/photon-alert-delivery";
import { sendPhotonWorkspaceAlertCard } from "@/agent/lib/photon-alert-outbound";
import { readPhotonAlertDeliverySubscription } from "@/agent/lib/photon-alert-subscription-store";
import { readWorkspaceAlertById } from "@/agent/lib/workspace-alert-store";
import {
  getWorkspaceMonitor,
  pauseWorkspaceMonitorAfterUncertainAlert,
} from "@/agent/lib/workspace-monitor-store";
import { authorizeDeploymentWorkspaceStore } from "@/agent/lib/workspace-store-authorization";

const OWNER_ID = "owner_adaam";
const WORKSPACE_ID = "ae35cb73-30a9-4127-9106-7fbc77463e1c";
const MONITOR_ID = "59acab8e-9c6c-5d2e-9f2f-ab171fe9d71e";
const ALERT_ID = "alert_bf24969ca3142c821eccee8257d1e09ee66b9518797ca230c5764726b05f80c2";

function authorized(request: Request): boolean {
  const supplied = request.headers.get("x-acceptance-secret") ?? "";
  const expected = process.env.EVE_IPO_DELIVERY_ACCEPTANCE_SECRET ?? "";
  if (!supplied || !expected) return false;
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const scope = authorizeDeploymentWorkspaceStore({
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
  });
  const [alert, monitor] = await Promise.all([
    readWorkspaceAlertById(scope, ALERT_ID),
    getWorkspaceMonitor(scope, MONITOR_ID),
  ]);
  if (
    !alert ||
    !monitor ||
    alert.workspaceId !== WORKSPACE_ID ||
    monitor.workspaceId !== WORKSPACE_ID ||
    monitor.managedBy?.packId !== "ipo-filings"
  ) {
    return Response.json({ error: "acceptance_target_unavailable" }, { status: 409 });
  }

  const subscription = await readPhotonAlertDeliverySubscription({
    ownerId: OWNER_ID,
    subscriptionId: monitor.deliverySubscriptionId,
  });
  const delivery = await deliverWorkspaceAlertToPhoton({
    alert,
    monitor,
    pauseMonitor: pauseWorkspaceMonitorAfterUncertainAlert,
    scope,
    send: (card) => sendPhotonWorkspaceAlertCard({
      card,
      destination: subscription.destination,
    }),
    subscription,
  });

  return Response.json({
    alertId: alert.alertId,
    deliveryId: delivery.deliveryId,
    state: delivery.state,
  });
}
