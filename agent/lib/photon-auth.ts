import type { SessionAuthContext } from "eve/context";

import {
  workspaceRuntimeScopeAttributes,
  type WorkspaceRuntimeScope,
} from "./workspace-runtime-scope";

const PHOTON_PRINCIPAL_PREFIX = "imessage:";

export function photonPrincipalId(senderId: string): string {
  return `${PHOTON_PRINCIPAL_PREFIX}${senderId}`;
}

export function photonSenderId(principalId: string): string | null {
  return principalId.startsWith(PHOTON_PRINCIPAL_PREFIX)
    ? principalId.slice(PHOTON_PRINCIPAL_PREFIX.length)
    : null;
}

export function photonAuth(
  senderId: string,
  threadId: string,
  scope: WorkspaceRuntimeScope,
): SessionAuthContext {
  return {
    attributes: {
      channel: "photon",
      thread_id: threadId,
      ...workspaceRuntimeScopeAttributes(scope),
    },
    authenticator: "photon-imessage-webhook",
    issuer: "photon-imessage",
    principalId: photonPrincipalId(senderId),
    principalType: "user",
    subject: senderId,
  };
}
