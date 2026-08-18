import { defineTool, type ToolContext } from "eve/tools";

import {
  coinbaseInteractiveCapabilityIds,
  requireCoinbaseAccess,
} from "../lib/coinbase-access";
import { callCoinbaseMcpTool } from "../lib/coinbase-mcp";
import { requireInteractiveToolCapabilities } from "../lib/interactive-tool-capabilities";
import {
  coinbaseOrderSchema,
  type CoinbaseOrder,
  createOrderPreviewToken,
  orderMcpInput,
} from "../lib/coinbase-order";

interface CoinbasePreviewOrderDependencies {
  readonly callCoinbaseMcpTool?: typeof callCoinbaseMcpTool;
  readonly requireInteractiveToolCapabilities?: typeof requireInteractiveToolCapabilities;
}

function assertTradableSpotProduct(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new Error("Coinbase did not return product metadata.");
  }
  const productType = Reflect.get(value, "product_type");
  const status = Reflect.get(value, "status");
  if (
    typeof productType !== "string" ||
    productType.toUpperCase() !== "SPOT"
  ) {
    throw new Error("Eve is restricted to Coinbase spot products.");
  }
  if (typeof status === "string" && status.toUpperCase() !== "ONLINE") {
    throw new Error("The requested Coinbase spot product is not online.");
  }
}

export async function executeCoinbasePreviewOrder(
  input: CoinbaseOrder,
  ctx: ToolContext,
  dependencies: CoinbasePreviewOrderDependencies = {},
) {
  const requireCapabilities =
    dependencies.requireInteractiveToolCapabilities ??
    requireInteractiveToolCapabilities;
  const callProvider =
    dependencies.callCoinbaseMcpTool ?? callCoinbaseMcpTool;

  await requireCapabilities({
    capabilityIds: coinbaseInteractiveCapabilityIds("coinbase_preview_order"),
    ctx,
    toolId: "coinbase_preview_order",
  });
  const principal = requireCoinbaseAccess(ctx);
  assertTradableSpotProduct(
    await callProvider(
      "coinbase_products_get",
      { product_id: input.productId },
      { signal: ctx.abortSignal },
    ),
  );

  const preview = await callProvider(
    "coinbase_orders_preview",
    orderMcpInput(input),
    { signal: ctx.abortSignal },
  );
  const authorization = createOrderPreviewToken(input, principal.id);

  return {
    authorization: {
      expiresAt: authorization.expiresAt,
      previewToken: authorization.token,
    },
    nextStep:
      "Show this exact preview to the user. Call coinbase_create_order only after the user explicitly authorizes the unchanged order.",
    order: input,
    preview,
  };
}

export default defineTool({
  description:
    "Preview one exact Coinbase spot order without executing it. Returns estimated fees, fill price, slippage, and a five-minute token required by coinbase_create_order.",
  inputSchema: coinbaseOrderSchema,
  async execute(input, ctx) {
    return executeCoinbasePreviewOrder(input, ctx);
  },
});
