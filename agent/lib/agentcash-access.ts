import type { SessionContext } from "eve/context";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";

import {
  InteractiveToolCapabilityDeniedError,
  requireInteractiveToolCapabilities,
} from "./interactive-tool-capabilities";
import {
  isAgentcashEvmPrivateKey,
  isAgentcashSolanaPrivateKey,
} from "./agentcash-wallet";

type Session = Pick<SessionContext["session"], "auth">;

export const AGENTCASH_CAPABILITY_ID = "agentcash_x402" as const;

export function agentcashInteractiveCapabilityIds(
  requiresPaymentApproval: boolean,
): readonly string[] {
  return Object.freeze([
    AGENTCASH_CAPABILITY_ID,
    ...(requiresPaymentApproval ? ["interactive.approval"] : []),
  ]);
}

export function agentcashPrincipalId(session: Session): string | undefined {
  const principal = session.auth.current ?? session.auth.initiator;
  return principal?.principalType === "user"
    ? principal.principalId
    : undefined;
}

export function agentcashWalletStatus(
  environment: NodeJS.ProcessEnv = process.env,
): { evm: boolean; solana: boolean } {
  return {
    evm: isAgentcashEvmPrivateKey(environment.X402_PRIVATE_KEY),
    solana: isAgentcashSolanaPrivateKey(
      environment.X402_SOLANA_PRIVATE_KEY,
    ),
  };
}

export function agentcashWalletConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const status = agentcashWalletStatus(environment);
  return status.evm || status.solana;
}

export function agentcashMaximumPaymentUsd(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment.AGENTCASH_MAX_PAYMENT_USD?.trim();
  const value = raw ? Number(raw) : 5;
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error(
      "AGENTCASH_MAX_PAYMENT_USD must be greater than 0 and no more than 100.",
    );
  }
  return value;
}

export function agentcashPrincipalAllowed(
  session: Session,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const principalId = agentcashPrincipalId(session);
  const allowed = new Set(
    (environment.AGENTCASH_ALLOWED_PRINCIPALS ?? "")
      .split(/[\n,]/u)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return principalId !== undefined && allowed.has(principalId);
}

export function requireAgentcashAccess(
  ctx: Pick<SessionContext, "session">,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const principalId = agentcashPrincipalId(ctx.session);
  if (!principalId) {
    throw new Error("An authenticated user is required for AgentCash.");
  }
  if (!agentcashPrincipalAllowed(ctx.session, environment)) {
    throw new Error(
      "This user is not authorized for AgentCash. Call agentcash_access_status and add the returned principalId to AGENTCASH_ALLOWED_PRINCIPALS.",
    );
  }
  if (!agentcashWalletConfigured(environment)) {
    throw new Error(
      "AgentCash requires at least one operator-controlled wallet. Configure a valid X402_PRIVATE_KEY and/or X402_SOLANA_PRIVATE_KEY value.",
    );
  }
  agentcashMaximumPaymentUsd(environment);
  return principalId;
}

export function agentcashPaymentApproval(
  ctx: Pick<ApprovalContext, "session">,
  environment: NodeJS.ProcessEnv = process.env,
): ApprovalStatus {
  if (!agentcashPrincipalAllowed(ctx.session, environment)) {
    return {
      type: "denied",
      reason: "This user is not authorized for AgentCash.",
    };
  }
  if (!agentcashWalletConfigured(environment)) {
    return {
      type: "denied",
      reason: "At least one operator-controlled AgentCash wallet must be configured.",
    };
  }
  try {
    agentcashMaximumPaymentUsd(environment);
  } catch (error) {
    return {
      type: "denied",
      reason:
        error instanceof Error
          ? error.message
          : "The AgentCash payment ceiling is invalid.",
    };
  }
  return "user-approval";
}

export async function requireAgentcashToolAccess(
  ctx: SessionContext,
  requiresPaymentApproval = false,
): Promise<string> {
  await requireInteractiveToolCapabilities({
    capabilityIds: agentcashInteractiveCapabilityIds(
      requiresPaymentApproval,
    ),
    ctx,
    toolId: requiresPaymentApproval ? "agentcash_fetch" : AGENTCASH_CAPABILITY_ID,
  });
  return requireAgentcashAccess(ctx);
}

export async function agentcashInteractivePaymentApproval(
  ctx: ApprovalContext,
): Promise<ApprovalStatus> {
  try {
    await requireInteractiveToolCapabilities({
      capabilityIds: agentcashInteractiveCapabilityIds(true),
      ctx,
      toolId: "agentcash_fetch",
    });
  } catch (error) {
    if (!(error instanceof InteractiveToolCapabilityDeniedError)) throw error;
    return {
      type: "denied",
      reason: "AgentCash is not available in the current strategy session.",
    };
  }
  return agentcashPaymentApproval(ctx);
}
