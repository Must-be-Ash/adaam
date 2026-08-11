export const PHOTON_APPROVAL_APP_PATH = "/eve/v1/photon-approval";
export const PHOTON_WORKSPACE_APP_PATH = "/eve/v1/photon-workspaces";

function deploymentOrigin(): URL {
  const configured =
    process.env.PHOTON_MINI_APP_BASE_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.VERCEL_URL;
  if (!configured) {
    throw new Error("The Photon mini-app deployment URL is unavailable.");
  }
  const origin = new URL(
    configured.startsWith("http") ? configured : `https://${configured}`,
  );
  if (
    origin.protocol !== "https:" &&
    !(process.env.NODE_ENV !== "production" && origin.protocol === "http:")
  ) {
    throw new Error("The Photon mini-app deployment URL must use HTTPS.");
  }
  return origin;
}

export function photonApprovalAppUrl(approvalToken: string): string {
  const url = new URL(PHOTON_APPROVAL_APP_PATH, deploymentOrigin());
  url.hash = approvalToken;
  return url.toString();
}

export function photonWorkspaceAppUrl(managerToken: string): string {
  const url = new URL(PHOTON_WORKSPACE_APP_PATH, deploymentOrigin());
  url.hash = managerToken;
  return url.toString();
}
