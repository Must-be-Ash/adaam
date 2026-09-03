import { createPrivateKey, createPublicKey } from "node:crypto";

import { base58 } from "@scure/base";

const EVM_PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const ED25519_PKCS8_SEED_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

export function isAgentcashEvmPrivateKey(value: string | undefined): boolean {
  return value !== undefined && EVM_PRIVATE_KEY_PATTERN.test(value);
}

export function isAgentcashSolanaPrivateKey(value: string | undefined): boolean {
  return normalizeAgentcashSolanaPrivateKey(value) !== undefined;
}

function solanaPublicKey(seed: Uint8Array): Uint8Array {
  const privateKey = createPrivateKey({
    format: "der",
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  return new Uint8Array(publicKey.subarray(-32));
}

export function normalizeAgentcashSolanaPrivateKey(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = base58.decode(value);
    if (decoded.length !== 32 && decoded.length !== 64) return undefined;
    const seed = decoded.slice(0, 32);
    const publicKey = solanaPublicKey(seed);
    if (
      decoded.length === 64 &&
      !Buffer.from(decoded.slice(32)).equals(Buffer.from(publicKey))
    ) {
      return undefined;
    }
    return base58.encode(
      decoded.length === 64
        ? decoded
        : new Uint8Array([...seed, ...publicKey]),
    );
  } catch {
    return undefined;
  }
}
