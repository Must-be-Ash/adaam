import type { SessionAuthContext } from "eve/context";

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
): SessionAuthContext {
  return {
    attributes: {
      channel: "photon",
      thread_id: threadId,
    },
    authenticator: "photon-imessage-webhook",
    issuer: "photon-imessage",
    principalId: photonPrincipalId(senderId),
    principalType: "user",
    subject: senderId,
  };
}
