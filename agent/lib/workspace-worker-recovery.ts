import { recoverCongressionalWorkspaceRunForControlPlane } from "./congressional-workspace-worker";
import { recoverSecIpoWorkspaceRunForControlPlane } from "./sec-ipo-workspace-worker";
import { recoverEarningsCallWorkspaceRunForControlPlane } from "./earnings-call-workspace-worker";
import type { WorkspaceWorkerControlPlaneClients } from "./workspace-worker-control-plane";
import type { PreparedWorkspaceWorkerRecovery } from "./workspace-worker-runner";

export async function recoverWorkspaceRunForControlPlane(input: {
  readonly clients?: WorkspaceWorkerControlPlaneClients;
  readonly now?: Date;
  readonly prepared: PreparedWorkspaceWorkerRecovery;
}) {
  const congressional = await recoverCongressionalWorkspaceRunForControlPlane(input);
  if (congressional.status !== "not_applicable") return congressional;
  const earnings = await recoverEarningsCallWorkspaceRunForControlPlane(input);
  if (earnings.status !== "not_applicable") return earnings;
  return recoverSecIpoWorkspaceRunForControlPlane(input);
}
