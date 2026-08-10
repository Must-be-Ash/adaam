import { defineTool } from "eve/tools";

import {
  coinbaseApproval,
  requireCoinbaseAccess,
} from "../lib/coinbase-access";
import { callCoinbaseMcpTool } from "../lib/coinbase-mcp";
import { executeCoinbaseMutation } from "../lib/coinbase-operation-store";
import {
  clientOrderIdForPreview,
  coinbaseCreateOrderSchema,
  orderMcpInput,
  verifyOrderPreviewToken,
} from "../lib/coinbase-order";

function assertSpotProduct(value: unknown): void {
  if (
    typeof value !== "object" ||
    value === null ||
    String(Reflect.get(value, "product_type")).toUpperCase() !== "SPOT"
  ) {
    throw new Error("Eve is restricted to Coinbase spot products.");
  }
}

export default defineTool({
  description:
    "Execute an explicitly authorized Coinbase spot order that exactly matches a fresh coinbase_preview_order result. This moves real funds and always requires user approval.",
  inputSchema: coinbaseCreateOrderSchema,
  approval: (ctx) => coinbaseApproval(ctx, true),
  async execute(input, ctx) {
    const principal = requireCoinbaseAccess(ctx);
    verifyOrderPreviewToken(input.previewToken, input, principal.id);
    assertSpotProduct(
      await callCoinbaseMcpTool(
        "coinbase_products_get",
        { product_id: input.productId },
        { signal: ctx.abortSignal },
      ),
    );

    const clientOrderId = clientOrderIdForPreview(input.previewToken);
    const toolInput = orderMcpInput(input, clientOrderId);
    const result = await executeCoinbaseMutation({
      callId: ctx.callId,
      operation: () =>
        callCoinbaseMcpTool("coinbase_orders_create", toolInput, {
          signal: ctx.abortSignal,
        }),
      principalId: principal.id,
      toolInput,
      toolName: "coinbase_orders_create",
    });

    return {
      clientOrderId,
      note:
        "The create response is authoritative for submission. Do not fetch or modify the order unless the user asks.",
      result,
    };
  },
});
