import { createHmac, timingSafeEqual } from "node:crypto";

const OWNER_ID_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/u;
const PHOTON_PRINCIPAL_PATTERN = /^imessage:.{1,300}$/u;
const HMAC_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const MAX_PHOTON_ALIASES = 8;

export interface OwnerIdentity {
  readonly ownerId: string;
  readonly principalAlias: string;
}

export interface OwnerConversationIdentity extends OwnerIdentity {
  readonly conversationId: string;
}

export const OWNER_RESOURCE_KINDS = [
  "session",
  "monitor",
  "manager",
  "worker",
  "alert",
] as const;

export type OwnerResourceKind = (typeof OWNER_RESOURCE_KINDS)[number];

export class OwnerIdentityDeniedError extends Error {
  readonly code = "owner_unmapped";

  constructor() {
    super("This authenticated Photon principal is not mapped to the deployment owner.");
    this.name = "OwnerIdentityDeniedError";
  }
}

function denied(): never {
  throw new OwnerIdentityDeniedError();
}

function ownerAlias(secret: Buffer, principalId: string): string {
  return createHmac("sha256", secret)
    .update("eve:owner-alias:v1\0")
    .update(principalId)
    .digest("hex");
}

function conversationAlias(
  secret: Buffer,
  ownerId: string,
  threadId: string,
): string {
  return `conversation_${createHmac("sha256", secret)
    .update("eve:conversation-alias:v1\0")
    .update(ownerId)
    .update("\0")
    .update(threadId)
    .digest("hex")}`;
}

function configuredPhotonPrincipals(value: string | undefined): Set<string> {
  const principals = (value ?? "")
    .split(/[,\n]/u)
    .map((principal) => principal.trim())
    .filter(Boolean);
  if (
    principals.length === 0 ||
    principals.length > MAX_PHOTON_ALIASES ||
    principals.some((principal) => !PHOTON_PRINCIPAL_PATTERN.test(principal)) ||
    new Set(principals).size !== principals.length
  ) {
    denied();
  }
  return new Set(principals);
}

function configuredSecret(value: string | undefined): Buffer {
  if (!value || !HMAC_SECRET_PATTERN.test(value)) denied();
  const secret = Buffer.from(value, "base64url");
  if (secret.byteLength < 32) denied();
  return secret;
}

export function resolvePhotonOwnerIdentity(
  principalId: string,
  environment: NodeJS.ProcessEnv = process.env,
): OwnerIdentity {
  const ownerId = environment.EVE_DEPLOYMENT_OWNER_ID;
  if (!ownerId || !OWNER_ID_PATTERN.test(ownerId)) denied();
  if (!PHOTON_PRINCIPAL_PATTERN.test(principalId)) denied();

  const principals = configuredPhotonPrincipals(
    environment.EVE_PHOTON_OWNER_PRINCIPALS,
  );
  if (!principals.has(principalId)) denied();

  const secret = configuredSecret(environment.EVE_OWNER_ALIAS_HMAC_SECRET);
  return Object.freeze({
    ownerId,
    principalAlias: ownerAlias(secret, principalId),
  });
}

export function resolvePhotonPrincipalByAlias(
  input: { ownerId: string; principalAlias: string },
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!/^[a-f0-9]{64}$/u.test(input.principalAlias)) denied();
  const candidates = configuredPhotonPrincipals(
    environment.EVE_PHOTON_OWNER_PRINCIPALS,
  );
  for (const principalId of candidates) {
    const identity = resolvePhotonOwnerIdentity(principalId, environment);
    if (identity.ownerId !== input.ownerId) continue;
    const actual = Buffer.from(identity.principalAlias, "hex");
    const expected = Buffer.from(input.principalAlias, "hex");
    if (actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)) {
      return principalId;
    }
  }
  denied();
}

export function requirePhotonOwnerAccess(
  input: {
    principalId: string;
    resource: OwnerResourceKind;
  },
  environment: NodeJS.ProcessEnv = process.env,
): OwnerIdentity {
  if (!OWNER_RESOURCE_KINDS.includes(input.resource)) denied();
  return resolvePhotonOwnerIdentity(input.principalId, environment);
}

export function resolvePhotonOwnerConversationIdentity(
  input: { principalId: string; threadId: string },
  environment: NodeJS.ProcessEnv = process.env,
): OwnerConversationIdentity {
  if (input.threadId.length < 1 || input.threadId.length > 500) denied();
  const owner = resolvePhotonOwnerIdentity(input.principalId, environment);
  const secret = configuredSecret(environment.EVE_OWNER_ALIAS_HMAC_SECRET);
  return Object.freeze({
    ...owner,
    conversationId: conversationAlias(secret, owner.ownerId, input.threadId),
  });
}
