import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { z } from "zod";

import {
  PUBLIC_COMMENTARY_LIMITS,
  digestPublicCommentaryValue,
  revocableEvidenceEnvelopeSchema,
  revocableEvidencePurgeReceiptSchema,
  type RevocableEvidenceEnvelope,
} from "./public-commentary-schema";

const MAX_RECORD_BYTES = 96 * 1_024;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const encryptedPayloadSchema = z.object({
  authTag: z.string().min(16).max(128),
  cipher: z.literal("aes-256-gcm"),
  ciphertext: z.string().min(1).max(128 * 1_024),
  iv: z.string().min(16).max(128),
  payloadDigest: digestSchema,
  recordType: z.literal("revocable_evidence_encrypted_payload"),
  schemaVersion: z.literal(1),
}).strict();

export interface RevocableEvidenceStoreClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<unknown>;
}

export class RevocableEvidenceStoreError extends Error {
  readonly code:
    | "revocable_evidence_conflict"
    | "revocable_evidence_corrupt"
    | "revocable_evidence_key_invalid"
    | "revocable_evidence_missing";

  constructor(code: RevocableEvidenceStoreError["code"]) {
    super(code);
    this.code = code;
    this.name = "RevocableEvidenceStoreError";
  }
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function serialize(value: unknown): string {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new RevocableEvidenceStoreError("revocable_evidence_corrupt");
  }
  return raw;
}

function parseRaw<T>(raw: string, parse: (value: unknown) => T): T {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new RevocableEvidenceStoreError("revocable_evidence_corrupt");
  }
  try {
    return parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof RevocableEvidenceStoreError) throw error;
    throw new RevocableEvidenceStoreError("revocable_evidence_corrupt");
  }
}

function assertEncryptionKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) {
    throw new RevocableEvidenceStoreError("revocable_evidence_key_invalid");
  }
  return Buffer.from(key);
}

function envelopeKey(envelopeId: string): string {
  return `revocable-envelope:${digestPublicCommentaryValue(envelopeId)}`;
}

function payloadKey(storageKey: string): string {
  return `revocable-payload:${digestPublicCommentaryValue(storageKey)}`;
}

function eventId(input: readonly unknown[]): string {
  return `event.${digestPublicCommentaryValue(input)}`;
}

function encryptPayload(plaintext: string, encryptionKey: Uint8Array) {
  const bytes = Buffer.from(plaintext, "utf8");
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > PUBLIC_COMMENTARY_LIMITS.maximumEncryptedPayloadBytes
  ) {
    throw new RevocableEvidenceStoreError("revocable_evidence_corrupt");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", assertEncryptionKey(encryptionKey), iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const record = encryptedPayloadSchema.parse({
    authTag: cipher.getAuthTag().toString("base64"),
    cipher: "aes-256-gcm",
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    payloadDigest: digestPublicCommentaryValue(plaintext),
    recordType: "revocable_evidence_encrypted_payload",
    schemaVersion: 1,
  });
  return Object.freeze({ byteCount: bytes.byteLength, record });
}

async function writePayload(
  storageKey: string,
  record: z.infer<typeof encryptedPayloadSchema>,
  client: RevocableEvidenceStoreClient,
): Promise<void> {
  const key = payloadKey(storageKey);
  const raw = serialize(record);
  if (await client.compareAndSet(key, null, raw)) return;
  if (rawValue(await client.get(key)) !== raw) {
    throw new RevocableEvidenceStoreError("revocable_evidence_conflict");
  }
}

export async function readRevocableEvidenceEnvelope(
  envelopeId: string,
  client: RevocableEvidenceStoreClient,
): Promise<RevocableEvidenceEnvelope | null> {
  const raw = rawValue(await client.get(envelopeKey(envelopeId)));
  return raw === null
    ? null
    : parseRaw(raw, (value) => revocableEvidenceEnvelopeSchema.parse(value));
}

export async function createRevocableEvidence(input: {
  readonly client: RevocableEvidenceStoreClient;
  readonly encryptionKey: Uint8Array;
  readonly keyReference: string;
  readonly lifecycle: "provisional" | "final";
  readonly observedAt: string;
  readonly plaintext: string;
  readonly providerObjectId: string;
}): Promise<RevocableEvidenceEnvelope> {
  const encrypted = encryptPayload(input.plaintext, input.encryptionKey);
  const envelopeId = `revocable-evidence.x.${input.providerObjectId}`;
  const storageKey = `revocable-evidence/x/${input.providerObjectId}/revision-1`;
  await writePayload(storageKey, encrypted.record, input.client);
  const envelope = revocableEvidenceEnvelopeSchema.parse({
    currentLifecycle: input.lifecycle,
    envelopeId,
    lifecycleEvents: [{
      eventId: eventId([envelopeId, 1, input.lifecycle, input.observedAt]),
      lifecycle: input.lifecycle,
      observedAt: input.observedAt,
      reasonCode: "provider_observed",
    }],
    payloadReference: {
      cipher: "aes-256-gcm",
      encryptedByteCount: encrypted.byteCount,
      keyReference: input.keyReference,
      payloadDigest: encrypted.record.payloadDigest,
      storageKey,
    },
    provider: "x",
    providerObjectId: input.providerObjectId,
    recordType: "revocable_evidence_envelope",
    revision: 1,
    schemaVersion: 1,
    sourceDigest: encrypted.record.payloadDigest,
  });
  const key = envelopeKey(envelopeId);
  const raw = serialize(envelope);
  if (await input.client.compareAndSet(key, null, raw)) return envelope;
  const existing = await readRevocableEvidenceEnvelope(envelopeId, input.client);
  if (
    existing?.sourceDigest === envelope.sourceDigest &&
    existing.currentLifecycle === envelope.currentLifecycle
  ) return existing;
  await input.client.delete(payloadKey(storageKey));
  throw new RevocableEvidenceStoreError("revocable_evidence_conflict");
}

export async function readRevocableEvidencePayload(input: {
  readonly client: RevocableEvidenceStoreClient;
  readonly encryptionKey: Uint8Array;
  readonly envelopeId: string;
}): Promise<string | null> {
  const envelope = await readRevocableEvidenceEnvelope(input.envelopeId, input.client);
  if (!envelope) throw new RevocableEvidenceStoreError("revocable_evidence_missing");
  if (envelope.payloadReference === null) return null;
  const raw = rawValue(await input.client.get(payloadKey(envelope.payloadReference.storageKey)));
  if (raw === null) throw new RevocableEvidenceStoreError("revocable_evidence_corrupt");
  const payload = parseRaw(raw, (value) => encryptedPayloadSchema.parse(value));
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      assertEncryptionKey(input.encryptionKey),
      Buffer.from(payload.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    if (digestPublicCommentaryValue(plaintext) !== payload.payloadDigest) {
      throw new Error("payload_digest_mismatch");
    }
    return plaintext;
  } catch {
    throw new RevocableEvidenceStoreError("revocable_evidence_corrupt");
  }
}

async function updateEnvelope(input: {
  readonly client: RevocableEvidenceStoreClient;
  readonly current: RevocableEvidenceEnvelope;
  readonly next: RevocableEvidenceEnvelope;
}): Promise<RevocableEvidenceEnvelope> {
  const key = envelopeKey(input.current.envelopeId);
  if (await input.client.compareAndSet(key, serialize(input.current), serialize(input.next))) {
    return input.next;
  }
  const raced = await readRevocableEvidenceEnvelope(input.current.envelopeId, input.client);
  if (raced && JSON.stringify(raced) === JSON.stringify(input.next)) return raced;
  throw new RevocableEvidenceStoreError("revocable_evidence_conflict");
}

export async function replaceRevocableEvidence(input: {
  readonly client: RevocableEvidenceStoreClient;
  readonly encryptionKey: Uint8Array;
  readonly envelopeId: string;
  readonly observedAt: string;
  readonly plaintext: string;
  readonly reasonCode?: "provider_edit" | "provider_rehydrated";
}): Promise<RevocableEvidenceEnvelope> {
  const current = await readRevocableEvidenceEnvelope(input.envelopeId, input.client);
  if (!current?.payloadReference) {
    throw new RevocableEvidenceStoreError("revocable_evidence_missing");
  }
  const encrypted = encryptPayload(input.plaintext, input.encryptionKey);
  if (encrypted.record.payloadDigest === current.sourceDigest) return current;
  const revision = current.revision + 1;
  const storageKey = `revocable-evidence/x/${current.providerObjectId}/revision-${revision}`;
  await writePayload(storageKey, encrypted.record, input.client);
  const next = revocableEvidenceEnvelopeSchema.parse({
    ...current,
    currentLifecycle: "edited",
    lifecycleEvents: [...current.lifecycleEvents, {
      eventId: eventId([current.envelopeId, revision, "edited", input.observedAt]),
      lifecycle: "edited",
      observedAt: input.observedAt,
      reasonCode: input.reasonCode ?? "provider_edit",
    }],
    payloadReference: {
      cipher: "aes-256-gcm",
      encryptedByteCount: encrypted.byteCount,
      keyReference: current.payloadReference.keyReference,
      payloadDigest: encrypted.record.payloadDigest,
      storageKey,
    },
    revision,
    sourceDigest: encrypted.record.payloadDigest,
  });
  try {
    const updated = await updateEnvelope({ client: input.client, current, next });
    await input.client.delete(payloadKey(current.payloadReference.storageKey));
    return updated;
  } catch (error) {
    await input.client.delete(payloadKey(storageKey));
    throw error;
  }
}

export async function transitionRevocableEvidence(input: {
  readonly client: RevocableEvidenceStoreClient;
  readonly envelopeId: string;
  readonly lifecycle: "final" | "unavailable" | "tombstoned";
  readonly observedAt: string;
  readonly reasonCode: string;
}): Promise<RevocableEvidenceEnvelope> {
  const current = await readRevocableEvidenceEnvelope(input.envelopeId, input.client);
  if (!current) throw new RevocableEvidenceStoreError("revocable_evidence_missing");
  if (current.currentLifecycle === input.lifecycle) return current;
  const next = revocableEvidenceEnvelopeSchema.parse({
    ...current,
    currentLifecycle: input.lifecycle,
    lifecycleEvents: [...current.lifecycleEvents, {
      eventId: eventId([
        current.envelopeId,
        current.revision,
        input.lifecycle,
        input.observedAt,
      ]),
      lifecycle: input.lifecycle,
      observedAt: input.observedAt,
      reasonCode: input.reasonCode,
    }],
    payloadReference: input.lifecycle === "tombstoned" ? null : current.payloadReference,
  });
  const updated = await updateEnvelope({ client: input.client, current, next });
  if (input.lifecycle === "tombstoned" && current.payloadReference) {
    await input.client.delete(payloadKey(current.payloadReference.storageKey));
  }
  return updated;
}

export async function purgeRevocableEvidence(input: {
  readonly client: RevocableEvidenceStoreClient;
  readonly envelopeId: string;
  readonly lifecycle: "deleted" | "protected" | "withheld" | "purged";
  readonly observedAt: string;
  readonly reason:
    | "account_protected"
    | "credential_removed"
    | "provider_deleted"
    | "provider_termination"
    | "provider_withheld"
    | "retention_expired";
}) {
  const current = await readRevocableEvidenceEnvelope(input.envelopeId, input.client);
  if (!current) throw new RevocableEvidenceStoreError("revocable_evidence_missing");
  if (!current.payloadReference) {
    throw new RevocableEvidenceStoreError("revocable_evidence_conflict");
  }
  const payloadDigest = current.payloadReference.payloadDigest;
  const next = revocableEvidenceEnvelopeSchema.parse({
    ...current,
    currentLifecycle: input.lifecycle,
    lifecycleEvents: [...current.lifecycleEvents, {
      eventId: eventId([
        current.envelopeId,
        current.revision,
        input.lifecycle,
        input.observedAt,
      ]),
      lifecycle: input.lifecycle,
      observedAt: input.observedAt,
      reasonCode: input.reason,
    }],
    payloadReference: null,
  });
  const updated = await updateEnvelope({ client: input.client, current, next });
  await input.client.delete(payloadKey(current.payloadReference.storageKey));
  const receiptInput = {
    envelopeId: current.envelopeId,
    payloadDigest,
    purgedAt: input.observedAt,
    reason: input.reason,
    recordType: "revocable_evidence_purge_receipt" as const,
    schemaVersion: 1 as const,
  };
  const receipt = revocableEvidencePurgeReceiptSchema.parse({
    ...receiptInput,
    receiptDigest: digestPublicCommentaryValue(receiptInput),
  });
  return Object.freeze({ envelope: updated, receipt });
}
