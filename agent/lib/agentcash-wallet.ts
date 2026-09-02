const EVM_PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const SOLANA_PRIVATE_KEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/u;

export function isAgentcashEvmPrivateKey(value: string | undefined): boolean {
  return value !== undefined && EVM_PRIVATE_KEY_PATTERN.test(value);
}

export function isAgentcashSolanaPrivateKey(value: string | undefined): boolean {
  return value !== undefined && SOLANA_PRIVATE_KEY_PATTERN.test(value);
}
