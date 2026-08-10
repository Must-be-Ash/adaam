import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  coinbasePrincipal,
  coinbasePrincipalAllowed,
} from "../lib/coinbase-access";
import {
  coinbaseCredentials,
  coinbaseCredentialsConfigured,
} from "../lib/coinbase-cli";

export default defineTool({
  description:
    "Show whether the current private iMessage or Telegram identity is authorized for Coinbase, without returning credentials, balances, or portfolio data.",
  inputSchema: z.object({}).strict(),
  execute(_input, ctx) {
    const principal = coinbasePrincipal(ctx.session);
    if (!principal) {
      throw new Error(
        "Open a private iMessage or Telegram conversation with Eve to inspect Coinbase access.",
      );
    }

    let credentialSource: "coinbase" | "compatible-alias" | "missing" =
      "missing";
    if (coinbaseCredentialsConfigured()) {
      credentialSource = coinbaseCredentials().source;
    }

    return {
      allowed: coinbasePrincipalAllowed(principal),
      channel: principal.channel,
      credentialsConfigured: credentialSource !== "missing",
      credentialSource,
      principalId: principal.id,
      requiredConfiguration: {
        allowedPrincipals: "COINBASE_ALLOWED_PRINCIPALS",
        keyId: "COINBASE_KEY_ID",
        keySecret: "COINBASE_KEY_SECRET",
      },
    };
  },
});
