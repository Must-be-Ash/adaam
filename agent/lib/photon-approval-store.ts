import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import type { PhotonApprovalPrompt } from "./photon-approval";

const ACTIVE_KEY_PREFIX = "eve:photon:v1:active-approval:";
const EVENT_KEY_PREFIX = "eve:photon:v1:approval-event:";
const RECORD_KEY_PREFIX = "eve:photon:v1:approval:";
const RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;
const EVENT_TTL_SECONDS = 24 * 60 * 60;
const RECORD_KEY_PATTERN =
  /^eve:photon:v1:approval:[a-f0-9]{64}$/u;

const approvalRecordSchema = z.object({
  approvalCode: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  createdAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
  pollTitle: z.string().min(1).max(160),
  principalHash: z.string().regex(/^[a-f0-9]{64}$/u),
  requestId: z.string().min(1).max(200),
  schemaVersion: z.literal(1),
  state: z.enum(["active", "draft"]),
  toolName: z.string().min(1).max(160),
});

type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

export type PhotonApprovalConsumption =
  | { status: "accepted"; requestId: string; toolName: string }
  | { status: "expired"; requestId: string; toolName: string }
  | { status: "forbidden" }
  | { status: "invalid" }
  | { status: "missing" }
  | { status: "unavailable" };

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

function approvalRecordKey(
  threadId: string,
  principalId: string,
  approvalCode: string,
): string {
  return `${RECORD_KEY_PREFIX}${sha256(
    `${approvalScope(threadId, principalId)}\u0000${approvalCode}`,
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

export async function savePhotonApproval(input: {
  principalId: string;
  prompt: PhotonApprovalPrompt;
  threadId: string;
}): Promise<void> {
  const record = approvalRecordSchema.parse({
    approvalCode: input.prompt.approvalCode,
    createdAtMs: Date.now(),
    expiresAtMs: input.prompt.expiresAtMs,
    pollTitle: input.prompt.pollTitle,
    principalHash: principalHash(input.principalId),
    requestId: input.prompt.requestId,
    schemaVersion: 1,
    state: "draft",
    toolName: input.prompt.toolName,
  });
  const recordKey = approvalRecordKey(
    input.threadId,
    input.principalId,
    input.prompt.approvalCode,
  );
  await redis().set(
    recordKey,
    JSON.stringify(record),
    { ex: RECORD_TTL_SECONDS },
  );
}

export async function activatePhotonApproval(input: {
  approvalCode: string;
  principalId: string;
  threadId: string;
}): Promise<void> {
  const recordKey = approvalRecordKey(
    input.threadId,
    input.principalId,
    input.approvalCode,
  );
  const record = parseRecord(await redis().get(recordKey));
  if (!record || record.state !== "draft") {
    throw new Error("The Photon approval draft is unavailable.");
  }
  const activated = await redis().set(
    recordKey,
    JSON.stringify({ ...record, state: "active" }),
    { ex: RECORD_TTL_SECONDS, xx: true },
  );
  if (!activated) {
    throw new Error("The Photon approval draft could not be activated.");
  }

  try {
    const activeKey = activeApprovalKey(input.threadId, input.principalId);
    const previousRecordKey = await redis().get(activeKey);
    await redis().set(activeKey, recordKey, { ex: RECORD_TTL_SECONDS });
    if (
      typeof previousRecordKey === "string" &&
      RECORD_KEY_PATTERN.test(previousRecordKey) &&
      previousRecordKey !== recordKey
    ) {
      await redis().del(previousRecordKey);
    }
  } catch {
    // The request-specific record is authoritative; this pointer only prunes
    // a superseded prompt.
  }
}

export async function clearPhotonApproval(input: {
  approvalCode: string;
  principalId: string;
  threadId: string;
}): Promise<void> {
  await redis().del(
    approvalRecordKey(
      input.threadId,
      input.principalId,
      input.approvalCode,
    ),
  );
}

async function consumeRecord(input: {
  principalId: string;
  recordKey: string;
}): Promise<PhotonApprovalConsumption> {
  const value = await redis().getdel(input.recordKey);
  if (value === null) return { status: "missing" };

  const record = parseRecord(value);
  if (!record) return { status: "invalid" };
  if (record.state !== "active") return { status: "unavailable" };
  if (record.principalHash !== principalHash(input.principalId)) {
    return { status: "forbidden" };
  }
  if (record.expiresAtMs < Date.now()) {
    return {
      status: "expired",
      requestId: record.requestId,
      toolName: record.toolName,
    };
  }
  return {
    status: "accepted",
    requestId: record.requestId,
    toolName: record.toolName,
  };
}

export async function consumePhotonApproval(input: {
  approvalCode: string;
  principalId: string;
  threadId: string;
}): Promise<PhotonApprovalConsumption> {
  return consumeRecord({
    principalId: input.principalId,
    recordKey: approvalRecordKey(
      input.threadId,
      input.principalId,
      input.approvalCode,
    ),
  });
}

export async function claimPhotonApprovalEvent(input: {
  eventId: string;
  principalId: string;
  threadId: string;
}): Promise<boolean> {
  const key = `${EVENT_KEY_PREFIX}${sha256(
    `${approvalScope(input.threadId, input.principalId)}\u0000${input.eventId}`,
  )}`;
  const claimed = await redis().set(key, "1", {
    ex: EVENT_TTL_SECONDS,
    nx: true,
  });
  return claimed === "OK";
}
