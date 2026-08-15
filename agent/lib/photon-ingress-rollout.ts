const RUNTIME_FLAG_NAMES = [
  "EVE_WORKSPACE_STATE_ENABLED",
  "EVE_WORKSPACE_MONITOR_WRITES_ENABLED",
  "EVE_WORKSPACE_DISPATCH_ENABLED",
  "EVE_WORKSPACE_PAID_RESEARCH_ENABLED",
  "EVE_PHOTON_WORKSPACE_ALERTS_ENABLED",
  "EVE_WORKSPACE_SOURCE_EVENTS_ENABLED",
] as const;

const OWNER_CONFIG_NAMES = [
  "EVE_DEPLOYMENT_OWNER_ID",
  "EVE_PHOTON_OWNER_PRINCIPALS",
  "EVE_OWNER_ALIAS_HMAC_SECRET",
] as const;

export type PhotonIngressRolloutMode = "durable" | "legacy";

export class PhotonIngressRolloutError extends Error {
  readonly code = "photon_ingress_rollout_invalid";

  constructor() {
    super("photon_ingress_rollout_invalid");
    this.name = "PhotonIngressRolloutError";
  }
}

function configured(value: string | undefined): boolean {
  return (value?.trim().length ?? 0) > 0;
}

function flag(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new PhotonIngressRolloutError();
}

function completePair(
  environment: NodeJS.ProcessEnv,
  urlName: "KV_REST_API_URL" | "UPSTASH_REDIS_REST_URL",
  tokenName: "KV_REST_API_TOKEN" | "UPSTASH_REDIS_REST_TOKEN",
): boolean {
  const url = configured(environment[urlName]);
  const token = configured(environment[tokenName]);
  if (url !== token) throw new PhotonIngressRolloutError();
  return url && token;
}

export function resolvePhotonIngressRolloutMode(
  environment: NodeJS.ProcessEnv = process.env,
): PhotonIngressRolloutMode {
  const flags = RUNTIME_FLAG_NAMES.map((name) => flag(environment[name]));
  const [state, ...nested] = flags;
  if (!state && nested.some(Boolean)) throw new PhotonIngressRolloutError();

  const ownerParts = OWNER_CONFIG_NAMES.map((name) => configured(environment[name]));
  const ownerConfigured = ownerParts.every(Boolean);
  if (ownerParts.some(Boolean) && !ownerConfigured) {
    throw new PhotonIngressRolloutError();
  }

  if (!ownerConfigured) {
    if (flags.some(Boolean)) throw new PhotonIngressRolloutError();
    return "legacy";
  }

  const redisConfigured = completePair(
    environment,
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
  ) || completePair(
    environment,
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  );
  if (!redisConfigured) throw new PhotonIngressRolloutError();
  return "durable";
}
