import { defineTool } from "eve/tools";

import {
  coinbaseInteractiveCapabilityIds,
  requireCoinbaseAccess,
} from "../lib/coinbase-access";
import { coinbaseEvalFixtureEnabled } from "#coinbase-eval-fixture";
import { callCoinbaseMcpTool } from "../lib/coinbase-mcp";
import { executeCoinbaseMutation } from "../lib/coinbase-operation-store";
import {
  coinbaseInteractiveApproval,
  requireInteractiveToolCapabilities,
} from "../lib/interactive-tool-capabilities";
import { markPhotonApprovalExecution } from "../lib/photon-approval-store";
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

async function markApprovalExecution(
  sessionId: string,
  state: "safe-failure" | "succeeded" | "uncertain",
): Promise<void> {
  if (coinbaseEvalFixtureEnabled()) return;
  await markPhotonApprovalExecution({ sessionId, state });
}

export default defineTool({
  description:
    "Execute an explicitly authorized Coinbase spot order that exactly matches a fresh coinbase_preview_order result. This moves real funds and always requires user approval.",
  inputSchema: coinbaseCreateOrderSchema,
  approval: (ctx) =>
    coinbaseInteractiveApproval({
      capabilityIds: coinbaseInteractiveCapabilityIds("coinbase_create_order"),
      ctx,
      requiresUserApproval: true,
      toolId: "coinbase_create_order",
    }),
  async execute(input, ctx) {
    await requireInteractiveToolCapabilities({
      capabilityIds: coinbaseInteractiveCapabilityIds("coinbase_create_order"),
      ctx,
      toolId: "coinbase_create_order",
    });
    const principal = requireCoinbaseAccess(ctx);
    let mutationStarted = false;
    try {
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
      mutationStarted = true;
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
      await markApprovalExecution(ctx.session.id, "succeeded").catch(
        (error: unknown) => {
          console.error("[coinbase.order] Approval outcome update failed", {
            error_type: error instanceof Error ? error.name : typeof error,
          });
        },
      );

      return {
        clientOrderId,
        note:
          "The create response is authoritative for submission. Do not fetch or modify the order unless the user asks.",
        result,
      };
    } catch (error) {
      await markApprovalExecution(
        ctx.session.id,
        mutationStarted ? "uncertain" : "safe-failure",
      ).catch(() => undefined);
      throw error;
    }
  },
});
