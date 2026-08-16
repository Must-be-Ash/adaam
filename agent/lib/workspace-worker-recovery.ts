import { recoverCongressionalWorkspaceRunForControlPlane } from "./congressional-workspace-worker";
import { recoverSecIpoWorkspaceRunForControlPlane } from "./sec-ipo-workspace-worker";
import type { WorkspaceWorkerControlPlaneClients } from "./workspace-worker-control-plane";
import type { PreparedWorkspaceWorkerRecovery } from "./workspace-worker-runner";

export async function recoverWorkspaceRunForControlPlane(input: {
  readonly clients?: WorkspaceWorkerControlPlaneClients;
  readonly now?: Date;
  readonly prepared: PreparedWorkspaceWorkerRecovery;
}) {
  const congressional = await recoverCongressionalWorkspaceRunForControlPlane(input);
  if (congressional.status !== "not_applicable") return congressional;
  return recoverSecIpoWorkspaceRunForControlPlane(input);
}
