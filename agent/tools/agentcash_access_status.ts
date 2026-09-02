import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  agentcashMaximumPaymentUsd,
  agentcashPrincipalAllowed,
  agentcashPrincipalId,
  agentcashWalletStatus,
} from "../lib/agentcash-access";

export default defineTool({
  description:
    "Show whether AgentCash x402 access is configured and whether the current authenticated user is allowlisted. Never returns private keys.",
  inputSchema: z.object({}).strict(),
  execute(_input, ctx) {
    const supportedWallets = agentcashWalletStatus();
    let maximumPaymentUsd: number | null = null;
    let configurationError: string | null = null;
    try {
      maximumPaymentUsd = agentcashMaximumPaymentUsd();
    } catch (error) {
      configurationError =
        error instanceof Error ? error.message : "Invalid AgentCash settings.";
    }
    return {
      allowed: agentcashPrincipalAllowed(ctx.session),
      configurationError,
      maximumPaymentUsd,
      principalId: agentcashPrincipalId(ctx.session),
      requiredConfiguration: {
        allowedPrincipals: "AGENTCASH_ALLOWED_PRINCIPALS",
        evmPrivateKey: "X402_PRIVATE_KEY",
        maximumPaymentUsd: "AGENTCASH_MAX_PAYMENT_USD",
        solanaPrivateKey: "X402_SOLANA_PRIVATE_KEY",
      },
      supportedWallets,
      walletConfigured: supportedWallets.evm && supportedWallets.solana,
    };
  },
});
