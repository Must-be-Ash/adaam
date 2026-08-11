import type { SessionAuthContext, SessionContext } from "eve/context";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";

import {
  coinbaseEvalFixtureEnabled,
  coinbaseEvalPrincipalId,
} from "#coinbase-eval-fixture";

const COINBASE_MUTATING_TOOLS = new Set([
  "coinbase_convert_execute",
  "coinbase_create_order",
  "coinbase_orders_cancel",
  "coinbase_orders_edit",
  "coinbase_portfolios_create",
  "coinbase_portfolios_delete",
  "coinbase_portfolios_edit",
  "coinbase_transfer",
]);

const COINBASE_PRIVATE_READ_TOOLS = new Set([
  "coinbase_balance",
  "coinbase_convert_get",
  "coinbase_convert_quote",
  "coinbase_fees",
  "coinbase_orders_fills",
  "coinbase_orders_get",
  "coinbase_orders_list",
  "coinbase_portfolios_get",
  "coinbase_portfolios_list",
]);

export interface CoinbasePrincipal {
  channel: "imessage" | "telegram";
  id: string;
}

type Session = Pick<SessionContext["session"], "auth">;

function stringAttribute(
  auth: SessionAuthContext,
  name: string,
): string | undefined {
  const value = auth.attributes[name];
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value[0] : undefined;
}

export function coinbasePrincipal(session: Session): CoinbasePrincipal | null {
  if (coinbaseEvalFixtureEnabled()) {
    return { channel: "imessage", id: coinbaseEvalPrincipalId() };
  }
  const auth = session.auth.current;
  if (!auth || auth.principalType !== "user") return null;

  if (auth.authenticator === "telegram-webhook") {
    if (stringAttribute(auth, "chat_type") !== "private") return null;
    const userId = stringAttribute(auth, "user_id");
    return userId ? { channel: "telegram", id: `telegram:${userId}` } : null;
  }

  if (
    auth.authenticator === "photon-imessage-webhook" &&
    stringAttribute(auth, "channel") === "photon" &&
    auth.principalId.startsWith("imessage:")
  ) {
    return { channel: "imessage", id: auth.principalId };
  }

  return null;
}

function configuredPrincipals(): ReadonlySet<string> {
  const principals = (process.env.COINBASE_ALLOWED_PRINCIPALS ?? "")
    .split(/[,\n]/u)
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(principals);
}

export function coinbasePrincipalAllowed(principal: CoinbasePrincipal): boolean {
  if (
    coinbaseEvalFixtureEnabled() &&
    principal.id === coinbaseEvalPrincipalId()
  ) {
    return true;
  }
  return configuredPrincipals().has(principal.id);
}

export function coinbaseToolIsPrivateRead(toolName: string): boolean {
  return COINBASE_PRIVATE_READ_TOOLS.has(toolName);
}

export function coinbaseToolRequiresApproval(toolName: string): boolean {
  return COINBASE_MUTATING_TOOLS.has(toolName);
}

export function requireCoinbaseAccess(ctx: SessionContext): CoinbasePrincipal {
  return requireCoinbaseSessionAccess(ctx.session);
}

function requireCoinbaseSessionAccess(session: Session): CoinbasePrincipal {
  const principal = coinbasePrincipal(session);
  if (!principal) {
    throw new Error(
      "Coinbase is available only to an authenticated user in a private iMessage or Telegram conversation.",
    );
  }
  if (!coinbasePrincipalAllowed(principal)) {
    throw new Error(
      "This private-chat identity is not authorized for the shared Coinbase portfolio. Call coinbase_access_status to obtain the principal ID, then add it to COINBASE_ALLOWED_PRINCIPALS.",
    );
  }
  return principal;
}

export function coinbaseApproval(
  ctx: ApprovalContext,
  requiresUserApproval: boolean,
): ApprovalStatus {
  try {
    requireCoinbaseSessionAccess(ctx.session);
  } catch (error) {
    return {
      type: "denied",
      reason:
        error instanceof Error
          ? error.message
          : "Coinbase access is not authorized.",
    };
  }

  return requiresUserApproval ? "user-approval" : "not-applicable";
}
