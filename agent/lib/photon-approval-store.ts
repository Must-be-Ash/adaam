import { createHash, randomBytes } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import type {
  PhotonApprovalDecision,
  PhotonApprovalPrompt,
} from "./photon-approval";

const ACTIVE_KEY_PREFIX = "eve:photon:v3:active-approval:";
// Keep event deduplication stable across approval-record schema generations so
// a retried YES/NO webhook can never be applied to a newer order.
const EVENT_KEY_PREFIX = "eve:photon:v2:approval-event:";
const RECORD_KEY_PREFIX = "eve:photon:v3:approval:";
const RECORD_TTL_SECONDS = 24 * 60 * 60;
const EVENT_TTL_SECONDS = 24 * 60 * 60;
const DRAFT_STALE_AFTER_MS = 60_000;
const APPROVAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ACTIVE_KEY_PATTERN =
  /^eve:photon:v3:active-approval:[a-f0-9]{64}$/u;
const RECORD_KEY_PATTERN = /^eve:photon:v3:approval:[a-f0-9]{64}$/u;

const RESERVE_APPROVAL_SCRIPT = `
local currentKey = redis.call("GET", KEYS[1])
if currentKey and currentKey ~= KEYS[2] then
  local currentValue = redis.call("GET", currentKey)
  local stale = not currentValue
  if currentValue then
    local decoded, record = pcall(cjson.decode, currentValue)
    if not decoded or record.schemaVersion ~= 1 then
      stale = true
    elseif record.sessionId == ARGV[5] and record.requestId == ARGV[6] then
      return cjson.encode({
        approvalToken = record.approvalToken,
        state = record.state,
        status = "existing"
      })
    elseif record.state == "draft" then
      stale = tonumber(record.createdAtMs) + tonumber(ARGV[4]) < tonumber(ARGV[3])
    elseif record.state == "delivered" or record.state == "unavailable" then
      stale = true
    else
      stale = tonumber(record.expiresAtMs) < tonumber(ARGV[3])
    end
  end
  if not stale then
    return 0
  end
  redis.call("DEL", currentKey)
end

if redis.call("EXISTS", KEYS[2]) == 1 then
  return -1
end
local saved = redis.call("SET", KEYS[2], ARGV[1], "EX", ARGV[2], "NX")
if not saved then
  return -1
end
redis.call("SET", KEYS[1], KEYS[2], "EX", ARGV[2])
return cjson.encode({status = "created"})
`;

const ACTIVATE_APPROVAL_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= KEYS[2] then
  return 0
end
local value = redis.call("GET", KEYS[2])
if not value then
  return 0
end
local decoded, record = pcall(cjson.decode, value)
if not decoded or record.schemaVersion ~= 1 or record.state ~= "draft" then
  return 0
end
record.state = "active"
redis.call("SET", KEYS[2], cjson.encode(record), "EX", ARGV[1], "XX")
return 1
`;

const CLEAR_APPROVAL_SCRIPT = `
local value = redis.call("GET", KEYS[2])
if not value then
  return 1
end
local decoded, record = pcall(cjson.decode, value)
if not decoded or record.schemaVersion ~= 1 or record.state ~= "draft" then
  return 0
end
if redis.call("GET", KEYS[1]) == KEYS[2] then
  redis.call("DEL", KEYS[1])
end
redis.call("DEL", KEYS[2])
return 1
`;

const CLAIM_APPROVAL_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if not value then
  return cjson.encode({status = "missing"})
end
local decoded, record = pcall(cjson.decode, value)
if not decoded or record.schemaVersion ~= 1 or record.activeKey ~= KEYS[2] then
  return cjson.encode({status = "invalid"})
end
if ARGV[4] ~= "" and record.principalHash ~= ARGV[4] then
  return cjson.encode({status = "forbidden"})
end
if record.state ~= "delivered" and redis.call("GET", KEYS[2]) ~= KEYS[1] then
  return cjson.encode({status = "invalid"})
end
if record.state == "draft" then
  return cjson.encode({status = "unavailable"})
end
if record.state == "unavailable" then
  return cjson.encode({status = "invalid"})
end
if record.state == "delivered" then
  return cjson.encode({status = "delivered", decision = record.decision})
end
if record.state == "delivering" then
  if record.decision ~= ARGV[1] and record.expiredDecision ~= true then
    return cjson.encode({status = "conflict"})
  end
  return cjson.encode({
    status = "deliver",
    expired = record.expiredDecision == true,
    record = record
  })
end
if record.state ~= "active" then
  return cjson.encode({status = "invalid"})
end

local expired = tonumber(record.expiresAtMs) < tonumber(ARGV[2])
local decision = ARGV[1]
if expired then
  decision = "deny"
end
record.state = "delivering"
record.decision = decision
record.decisionAtMs = tonumber(ARGV[2])
record.expiredDecision = expired
redis.call("SET", KEYS[1], cjson.encode(record), "EX", ARGV[3], "XX")
return cjson.encode({status = "deliver", expired = expired, record = record})
`;

const COMPLETE_APPROVAL_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if not value then
  return 0
end
local decoded, record = pcall(cjson.decode, value)
if not decoded or record.schemaVersion ~= 1 or record.activeKey ~= KEYS[2] then
  return 0
end
if record.state == "delivered" and record.decision == ARGV[1] then
  return 1
end
if record.state ~= "delivering" or record.decision ~= ARGV[1] then
  return 0
end
record.state = "delivered"
record.deliveredAtMs = tonumber(ARGV[2])
redis.call("SET", KEYS[1], cjson.encode(record), "EX", ARGV[3], "XX")
if redis.call("GET", KEYS[2]) == KEYS[1] then
  redis.call("DEL", KEYS[2])
end
return 1
`;

const FAIL_APPROVAL_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if not value then
  return 0
end
local decoded, record = pcall(cjson.decode, value)
if not decoded or record.schemaVersion ~= 1 or record.activeKey ~= KEYS[2] then
  return 0
end
if record.state ~= "delivering" or record.decision ~= ARGV[1] then
  return 0
end
record.state = "unavailable"
record.failureAtMs = tonumber(ARGV[2])
redis.call("SET", KEYS[1], cjson.encode(record), "EX", ARGV[3], "XX")
if redis.call("GET", KEYS[2]) == KEYS[1] then
  redis.call("DEL", KEYS[2])
end
return 1
`;

const approvalRecordSchema = z.object({
  activeKey: z.string().regex(ACTIVE_KEY_PATTERN),
  approvalToken: z.string().regex(APPROVAL_TOKEN_PATTERN),
  approvalText: z.string().min(1).max(500),
  createdAtMs: z.number().int().nonnegative(),
  decision: z.enum(["approve", "deny"]).optional(),
  decisionAtMs: z.number().int().nonnegative().optional(),
  deliveredAtMs: z.number().int().nonnegative().optional(),
  expiredDecision: z.boolean().optional(),
  expiresAtMs: z.number().int().positive(),
  failureAtMs: z.number().int().nonnegative().optional(),
  principalHash: z.string().regex(/^[a-f0-9]{64}$/u),
  principalId: z.string().regex(/^imessage:.+$/u).max(320),
  requestId: z.string().min(1).max(200),
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1).max(200),
  state: z.enum([
    "active",
    "delivered",
    "delivering",
    "draft",
    "unavailable",
  ]),
  threadId: z.string().min(1).max(500),
  toolName: z.string().min(1).max(160),
});

type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

const reservationResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("created") }),
  z.object({
    approvalToken: z.string().regex(APPROVAL_TOKEN_PATTERN),
    state: approvalRecordSchema.shape.state,
    status: z.literal("existing"),
  }),
]);

const claimResponseSchema = z.discriminatedUnion("status", [
  z.object({
    expired: z.boolean(),
    record: approvalRecordSchema,
    status: z.literal("deliver"),
  }),
  z.object({
    decision: z.enum(["approve", "deny"]),
    status: z.literal("delivered"),
  }),
  z.object({ status: z.literal("conflict") }),
  z.object({ status: z.literal("forbidden") }),
  z.object({ status: z.literal("invalid") }),
  z.object({ status: z.literal("missing") }),
  z.object({ status: z.literal("unavailable") }),
]);

export interface PhotonApprovalDelivery {
  decision: PhotonApprovalDecision;
  expired: boolean;
  principalId: string;
  recordKey: string;
  requestId: string;
  sessionId: string;
  threadId: string;
  toolName: string;
}

export type PhotonApprovalDeliveryLookup =
  | { delivery: PhotonApprovalDelivery; status: "deliver" }
  | { status: "delivered" };

export type PhotonApprovalClaim =
  | { delivery: PhotonApprovalDelivery; status: "deliver" }
  | { decision: PhotonApprovalDecision; status: "delivered" }
  | {
      status:
        | "conflict"
        | "forbidden"
        | "invalid"
        | "missing"
        | "unavailable";
    };

export type PhotonApprovalView =
  | {
      approvalText: string;
      expiresAtMs: number;
      status:
        | "active"
        | "expired"
        | "opening"
        | "processing"
        | "unavailable";
    }
  | {
      approvalText: string;
      decision: PhotonApprovalDecision;
      expiresAtMs: number;
      status: "delivered";
    }
  | { status: "invalid" | "missing" };

export interface PhotonApprovalStoreClient {
  eval(
    script: string,
    keys: string[],
    args: unknown[],
  ): Promise<unknown>;
  get(key: string): Promise<unknown>;
}

export interface PhotonApprovalEventStoreClient {
  set(
    key: string,
    value: string,
    options: { ex: number; nx: true },
  ): Promise<unknown>;
}

let redisClient: Redis | undefined;

function redis(): Redis {
  if (redisClient) return redisClient;
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Photon approval storage is not configured. Connect the isolated Upstash Redis resource.",
    );
  }
  redisClient = new Redis({
    url,
    token,
    automaticDeserialization: false,
  });
  return redisClient;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function principalHash(principalId: string): string {
  return sha256(`principal\u0000${principalId}`);
}

function approvalScope(threadId: string, principalId: string): string {
  return sha256(
    `thread\u0000${threadId}\u0000${principalHash(principalId)}`,
  );
}

function activeApprovalKey(threadId: string, principalId: string): string {
  return `${ACTIVE_KEY_PREFIX}${approvalScope(threadId, principalId)}`;
}

function approvalRecordKey(approvalToken: string): string | null {
  if (!APPROVAL_TOKEN_PATTERN.test(approvalToken)) return null;
  return `${RECORD_KEY_PREFIX}${sha256(
    `approval-token\u0000${approvalToken}`,
  )}`;
}

function parseRecord(value: unknown): ApprovalRecord | null {
  if (typeof value !== "string") return null;
  try {
    return approvalRecordSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseClaimResponse(value: unknown) {
  const parsed =
    typeof value === "string" ? JSON.parse(value) : value;
  return claimResponseSchema.parse(parsed);
}

function parseReservationResponse(value: unknown) {
  const parsed =
    typeof value === "string" ? JSON.parse(value) : value;
  return reservationResponseSchema.parse(parsed);
}

function deliveryFromRecord(
  recordKey: string,
  record: ApprovalRecord,
  expired: boolean,
): PhotonApprovalDelivery {
  if (!record.decision) {
    throw new Error("The Photon approval decision is missing.");
  }
  return {
    decision: record.decision,
    expired,
    principalId: record.principalId,
    recordKey,
    requestId: record.requestId,
    sessionId: record.sessionId,
    threadId: record.threadId,
    toolName: record.toolName,
  };
}

async function claimRecord(input: {
  activeKey: string;
  client: PhotonApprovalStoreClient;
  decision: PhotonApprovalDecision;
  expectedPrincipalHash?: string;
  recordKey: string;
}): Promise<PhotonApprovalClaim> {
  const raw = await input.client.eval(
    CLAIM_APPROVAL_SCRIPT,
    [input.recordKey, input.activeKey],
    [
      input.decision,
      Date.now(),
      RECORD_TTL_SECONDS,
      input.expectedPrincipalHash ?? "",
    ],
  );
  const claimed = parseClaimResponse(raw);
  if (claimed.status === "deliver") {
    return {
      delivery: deliveryFromRecord(
        input.recordKey,
        claimed.record,
        claimed.expired,
      ),
      status: "deliver",
    };
  }
  return claimed;
}

export async function savePhotonApproval(input: {
  principalId: string;
  prompt: PhotonApprovalPrompt;
  sessionId: string;
  threadId: string;
}): Promise<{
  approvalToken: string;
  reused: boolean;
  state: ApprovalRecord["state"];
}> {
  const approvalToken = randomBytes(32).toString("base64url");
  const recordKey = approvalRecordKey(approvalToken);
  if (!recordKey) {
    throw new Error("The Photon approval token could not be created.");
  }
  const activeKey = activeApprovalKey(input.threadId, input.principalId);
  const record = approvalRecordSchema.parse({
    activeKey,
    approvalToken,
    approvalText: input.prompt.approvalText,
    createdAtMs: Date.now(),
    expiresAtMs: input.prompt.expiresAtMs,
    principalHash: principalHash(input.principalId),
    principalId: input.principalId,
    requestId: input.prompt.requestId,
    schemaVersion: 1,
    sessionId: input.sessionId,
    state: "draft",
    threadId: input.threadId,
    toolName: input.prompt.toolName,
  });
  const reserved = await redis().eval(
    RESERVE_APPROVAL_SCRIPT,
    [activeKey, recordKey],
    [
      JSON.stringify(record),
      RECORD_TTL_SECONDS,
      Date.now(),
      DRAFT_STALE_AFTER_MS,
      input.sessionId,
      input.prompt.requestId,
    ],
  );
  if (reserved === 0) {
    throw new Error(
      "Another Photon approval is already active for this conversation.",
    );
  }
  if (reserved === -1) {
    throw new Error("The Photon approval record could not be reserved.");
  }
  const result = parseReservationResponse(reserved);
  if (result.status === "existing") {
    return {
      approvalToken: result.approvalToken,
      reused: true,
      state: result.state,
    };
  }
  return { approvalToken, reused: false, state: "draft" };
}

export async function activatePhotonApproval(input: {
  approvalToken: string;
  principalId: string;
  threadId: string;
}): Promise<void> {
  const recordKey = approvalRecordKey(input.approvalToken);
  if (!recordKey) {
    throw new Error("The Photon approval token is invalid.");
  }
  const activated = await redis().eval(
    ACTIVATE_APPROVAL_SCRIPT,
    [activeApprovalKey(input.threadId, input.principalId), recordKey],
    [RECORD_TTL_SECONDS],
  );
  if (activated !== 1) {
    throw new Error("The Photon approval draft could not be activated.");
  }
}

export async function clearPhotonApproval(input: {
  approvalToken: string;
  principalId: string;
  threadId: string;
}): Promise<boolean> {
  const recordKey = approvalRecordKey(input.approvalToken);
  if (!recordKey) return false;
  const cleared = await redis().eval(
    CLEAR_APPROVAL_SCRIPT,
    [activeApprovalKey(input.threadId, input.principalId), recordKey],
    [],
  );
  return cleared === 1;
}

export async function claimCurrentPhotonApprovalDecision(
  input: {
    decision: PhotonApprovalDecision;
    principalId: string;
    threadId: string;
  },
  client: PhotonApprovalStoreClient = redis(),
): Promise<PhotonApprovalClaim> {
  const activeKey = activeApprovalKey(input.threadId, input.principalId);
  const recordKey = await client.get(activeKey);
  if (
    typeof recordKey !== "string" ||
    !RECORD_KEY_PATTERN.test(recordKey)
  ) {
    return { status: "missing" };
  }
  return claimRecord({
    activeKey,
    client,
    decision: input.decision,
    expectedPrincipalHash: principalHash(input.principalId),
    recordKey,
  });
}

export async function claimPhotonApprovalDecision(
  input: {
    approvalToken: string;
    decision: PhotonApprovalDecision;
  },
  client: PhotonApprovalStoreClient = redis(),
): Promise<PhotonApprovalClaim> {
  const recordKey = approvalRecordKey(input.approvalToken);
  if (!recordKey) return { status: "invalid" };
  const record = parseRecord(await client.get(recordKey));
  if (!record) return { status: "missing" };
  return claimRecord({
    activeKey: record.activeKey,
    client,
    decision: input.decision,
    recordKey,
  });
}

export async function completePhotonApprovalDecision(input: {
  decision: PhotonApprovalDecision;
  recordKey: string;
}): Promise<void> {
  if (!RECORD_KEY_PATTERN.test(input.recordKey)) {
    throw new Error("The Photon approval delivery key is invalid.");
  }
  const record = parseRecord(await redis().get(input.recordKey));
  if (!record) {
    throw new Error("The Photon approval delivery record is unavailable.");
  }
  const completed = await redis().eval(
    COMPLETE_APPROVAL_SCRIPT,
    [input.recordKey, record.activeKey],
    [input.decision, Date.now(), RECORD_TTL_SECONDS],
  );
  if (completed !== 1) {
    throw new Error("The Photon approval delivery could not be completed.");
  }
}

export async function failPhotonApprovalDecision(input: {
  decision: PhotonApprovalDecision;
  recordKey: string;
}): Promise<void> {
  if (!RECORD_KEY_PATTERN.test(input.recordKey)) {
    throw new Error("The Photon approval delivery key is invalid.");
  }
  const record = parseRecord(await redis().get(input.recordKey));
  if (!record) {
    throw new Error("The Photon approval delivery record is unavailable.");
  }
  const failed = await redis().eval(
    FAIL_APPROVAL_SCRIPT,
    [input.recordKey, record.activeKey],
    [input.decision, Date.now(), RECORD_TTL_SECONDS],
  );
  if (failed !== 1) {
    throw new Error("The Photon approval delivery could not be failed.");
  }
}

export async function getPhotonApprovalDelivery(
  input: {
    decision: PhotonApprovalDecision;
    recordKey: string;
  },
  client: PhotonApprovalStoreClient = redis(),
): Promise<PhotonApprovalDeliveryLookup | null> {
  if (!RECORD_KEY_PATTERN.test(input.recordKey)) return null;
  const record = parseRecord(await client.get(input.recordKey));
  if (!record || record.decision !== input.decision) return null;
  if (record.state === "delivered") return { status: "delivered" };
  if (
    record.state !== "delivering" ||
    (await client.get(record.activeKey)) !== input.recordKey
  ) {
    return null;
  }
  return {
    delivery: deliveryFromRecord(
      input.recordKey,
      record,
      record.expiredDecision === true,
    ),
    status: "deliver",
  };
}

export async function getPhotonApprovalView(
  approvalToken: string,
  client: PhotonApprovalStoreClient = redis(),
): Promise<PhotonApprovalView> {
  const recordKey = approvalRecordKey(approvalToken);
  if (!recordKey) return { status: "invalid" };
  const record = parseRecord(await client.get(recordKey));
  if (!record) return { status: "missing" };
  if (
    record.state !== "delivered" &&
    record.state !== "unavailable" &&
    (await client.get(record.activeKey)) !== recordKey
  ) {
    return { status: "invalid" };
  }
  const common = {
    approvalText: record.approvalText,
    expiresAtMs: record.expiresAtMs,
  };
  if (record.state === "draft") return { ...common, status: "opening" };
  if (record.state === "delivering") {
    return { ...common, status: "processing" };
  }
  if (record.state === "unavailable") {
    return { ...common, status: "unavailable" };
  }
  if (record.state === "delivered" && record.decision) {
    return {
      ...common,
      decision: record.decision,
      status: "delivered",
    };
  }
  return {
    ...common,
    status: record.expiresAtMs < Date.now() ? "expired" : "active",
  };
}

export async function hasCurrentPhotonApproval(input: {
  principalId: string;
  threadId: string;
}): Promise<boolean> {
  const client = redis();
  const recordKey = await client.get(
    activeApprovalKey(input.threadId, input.principalId),
  );
  if (
    typeof recordKey !== "string" ||
    !RECORD_KEY_PATTERN.test(recordKey)
  ) {
    return false;
  }
  const record = parseRecord(await client.get(recordKey));
  return (
    record !== null &&
    record.state !== "delivered" &&
    record.state !== "unavailable"
  );
}

export async function claimPhotonApprovalEvent(input: {
  eventId: string;
  principalId: string;
  threadId: string;
}, client: PhotonApprovalEventStoreClient = redis()): Promise<boolean> {
  const key = `${EVENT_KEY_PREFIX}${sha256(
    `${approvalScope(input.threadId, input.principalId)}\u0000${input.eventId}`,
  )}`;
  const claimed = await client.set(key, "1", {
    ex: EVENT_TTL_SECONDS,
    nx: true,
  });
  return claimed === "OK";
}
