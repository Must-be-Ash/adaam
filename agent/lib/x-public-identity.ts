import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { PUBLIC_COMMENTARY_SOURCE_CONTRACT } from "./public-commentary-source-contract";

const usernameSchema = z.string().regex(/^[A-Za-z0-9_]{1,15}$/u);
const confirmedIdentitySchema = z.tuple([
  z.string().url().max(200),
  usernameSchema,
  z.string().trim().min(1).max(160),
  z.string().regex(/^\d{1,20}$/u),
  z.literal("confirmed"),
]);
const responseSchema = z.object({
  data: z.object({
    id: z.string().regex(/^\d{1,20}$/u),
    name: z.string().trim().min(1).max(160),
    username: usernameSchema,
  }).strict(),
}).passthrough();
export const xPublicIdentityResolutionReceiptSchema = z.object({
  identityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  issuedAt: z.string().datetime({ offset: true }),
  principalId: z.string().min(1).max(200),
  signature: z.string().regex(/^[a-f0-9]{64}$/u),
  threadId: z.string().min(1).max(200),
}).strict();
export type XPublicIdentityResolutionReceipt = z.infer<typeof xPublicIdentityResolutionReceiptSchema>;

type ResolvedXPublicIdentity = Readonly<{
  displayName: string;
  numericUserId: string;
  profileUrl: string;
  username: string;
}>;

function identityDigest(identity: ResolvedXPublicIdentity): string {
  return createHash("sha256").update(JSON.stringify([
    identity.profileUrl, identity.username, identity.displayName, identity.numericUserId,
  ])).digest("hex");
}

function receiptPayload(receipt: Omit<XPublicIdentityResolutionReceipt, "signature">): string {
  return JSON.stringify([receipt.identityDigest, receipt.issuedAt, receipt.principalId, receipt.threadId]);
}

export function mintXPublicIdentityResolutionReceipt(
  identity: ResolvedXPublicIdentity,
  scope: Readonly<{ issuedAt?: Date; principalId: string; threadId: string }>,
  secret: string,
): XPublicIdentityResolutionReceipt {
  const unsigned = {
    identityDigest: identityDigest(identity),
    issuedAt: (scope.issuedAt ?? new Date()).toISOString(),
    principalId: scope.principalId,
    threadId: scope.threadId,
  };
  return Object.freeze({
    ...unsigned,
    signature: createHmac("sha256", secret).update(receiptPayload(unsigned)).digest("hex"),
  });
}

export function verifyXPublicIdentityResolutionReceipt(
  value: unknown,
  identity: ResolvedXPublicIdentity,
  scope: Readonly<{ now?: Date; principalId: string; threadId: string }>,
  secret: string,
): void {
  const receipt = xPublicIdentityResolutionReceiptSchema.parse(value);
  const now = (scope.now ?? new Date()).getTime();
  const issuedAt = Date.parse(receipt.issuedAt);
  const expected = createHmac("sha256", secret).update(receiptPayload({
    identityDigest: receipt.identityDigest,
    issuedAt: receipt.issuedAt,
    principalId: receipt.principalId,
    threadId: receipt.threadId,
  })).digest();
  const provided = Buffer.from(receipt.signature, "hex");
  if (
    receipt.identityDigest !== identityDigest(identity) || receipt.principalId !== scope.principalId ||
    receipt.threadId !== scope.threadId || issuedAt > now + 60_000 || now - issuedAt > 15 * 60_000 ||
    provided.byteLength !== expected.byteLength || !timingSafeEqual(provided, expected)
  ) throw new Error("x_identity_resolution_receipt_invalid");
}

export function normalizeXPublicProfile(value: string): Readonly<{ profileUrl: string; username: string }> {
  const trimmed = value.trim();
  const candidate = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  let username = candidate;
  if (/^https?:\/\//iu.test(candidate)) {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !["x.com", "www.x.com"].includes(url.hostname) ||
        url.search !== "" || url.hash !== "") throw new Error("x_profile_invalid");
    const path = url.pathname.split("/").filter(Boolean);
    if (path.length !== 1) throw new Error("x_profile_invalid");
    username = path[0]!;
  }
  const parsed = usernameSchema.safeParse(username);
  if (!parsed.success) throw new Error("x_profile_invalid");
  return Object.freeze({ profileUrl: `https://x.com/${parsed.data}`, username: parsed.data });
}

export function parseConfirmedXPublicIdentity(value: unknown): ResolvedXPublicIdentity {
  const [storedProfileUrl, storedUsername, displayName, numericUserId] = confirmedIdentitySchema.parse(value);
  const normalized = normalizeXPublicProfile(storedProfileUrl);
  if (
    normalized.profileUrl !== storedProfileUrl.replace(/\/$/u, "") ||
    normalized.username.toLowerCase() !== storedUsername.toLowerCase()
  ) throw new Error("x_identity_mismatch");
  return Object.freeze({ displayName, numericUserId, profileUrl: normalized.profileUrl, username: storedUsername });
}

export async function resolveXPublicIdentity(input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly profile: string;
}): Promise<Readonly<{
  displayName: string;
  numericUserId: string;
  profileUrl: string;
  username: string;
}>> {
  const profile = normalizeXPublicProfile(input.profile);
  const bearer = (input.environment ?? process.env).X_BEARER_TOKEN?.trim();
  if (!bearer) throw new Error("x_bearer_token_missing");
  const endpointTemplate = PUBLIC_COMMENTARY_SOURCE_CONTRACT.x.timeline.identityLookupEndpointTemplate;
  const url = new URL(endpointTemplate.replace("{username}", encodeURIComponent(profile.username)));
  const expectedOrigin = new URL(endpointTemplate).origin;
  url.searchParams.set("user.fields", "id,name,username");
  const response = await (input.fetchImpl ?? fetch)(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200 || new URL(response.url || url).origin !== expectedOrigin) {
    throw new Error("x_identity_unavailable");
  }
  const body = responseSchema.parse(await response.json());
  if (body.data.username.toLowerCase() !== profile.username.toLowerCase()) {
    throw new Error("x_identity_mismatch");
  }
  return Object.freeze({
    displayName: body.data.name,
    numericUserId: body.data.id,
    profileUrl: `https://x.com/${body.data.username}`,
    username: body.data.username,
  });
}
