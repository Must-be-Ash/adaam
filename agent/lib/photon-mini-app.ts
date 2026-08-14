import {
  publicApplicationOrigin,
  publicArtifactPageUrl,
} from "#public-app-url";

export const PHOTON_APPROVAL_APP_PATH = "/eve/v1/photon-approval";
export const PHOTON_WORKSPACE_APP_PATH = "/eve/v1/photon-workspaces";

const PHOTON_ARTIFACT_HOST = "miniup.app";
const PHOTON_PUBLIC_URL_PATTERN = /https:\/\/[^\s<>"'`)\]}]+/giu;

export interface PhotonArtifactPresentation {
  message: string;
  url: string;
}

function publicPhotonArtifactUrl(candidate: string): string | null {
  const internalArtifactUrl = publicArtifactPageUrl(candidate);
  if (internalArtifactUrl) return internalArtifactUrl;

  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (hostname === PHOTON_ARTIFACT_HOST ||
        hostname.endsWith(`.${PHOTON_ARTIFACT_HOST}`))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function deploymentOrigin(): URL {
  return publicApplicationOrigin();
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

export function photonArtifactPresentation(
  message: string,
): PhotonArtifactPresentation | null {
  const markerMatch = message.match(
    /^[ \t]*ARTIFACT_URL:[ \t]*(https:\/\/\S+)[ \t]*$/imu,
  );
  const markerUrl = markerMatch?.[1]
    ? publicPhotonArtifactUrl(markerMatch[1])
    : null;
  const publicUrl =
    markerUrl ??
    [...message.matchAll(PHOTON_PUBLIC_URL_PATTERN)]
      .map((match) => publicPhotonArtifactUrl(match[0]))
      .find((url): url is string => Boolean(url)) ??
    null;
  if (!publicUrl) return null;

  if (!markerUrl || !markerMatch?.[0]) {
    return { message, url: publicUrl };
  }
  const visibleFallback = `Open the artifact:\n${publicUrl}`;
  const matchIndex = markerMatch.index ?? 0;
  return {
    message:
      `${message.slice(0, matchIndex)}${visibleFallback}${message.slice(
        matchIndex + markerMatch[0].length,
      )}`.trim(),
    url: publicUrl,
  };
}
