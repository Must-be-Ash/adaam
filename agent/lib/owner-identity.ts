import { createHmac } from "node:crypto";

const OWNER_ID_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/u;
const PHOTON_PRINCIPAL_PATTERN = /^imessage:.{1,300}$/u;
const HMAC_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const MAX_PHOTON_ALIASES = 8;

export interface OwnerIdentity {
  readonly ownerId: string;
  readonly principalAlias: string;
}

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
