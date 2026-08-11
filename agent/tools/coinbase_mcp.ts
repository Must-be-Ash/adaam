import { defineDynamic, defineTool } from "eve/tools";

import {
  coinbaseApproval,
  coinbasePrincipal,
  coinbasePrincipalAllowed,
  coinbaseToolIsPrivateRead,
  coinbaseToolRequiresApproval,
  requireCoinbaseAccess,
} from "../lib/coinbase-access";
import {
  callCoinbaseMcpTool,
  listCoinbaseMcpTools,
  type CoinbaseMcpToolDefinition,
} from "../lib/coinbase-mcp";
import { validateCoinbaseMcpInput } from "../lib/coinbase-mcp-policy";
import { executeCoinbaseMutation } from "../lib/coinbase-operation-store";

const ALLOWED_TOOLS = new Set([
  "coinbase_help",
  "coinbase_convert_quote",
  "coinbase_convert_execute",
  "coinbase_convert_get",
  "coinbase_orders_list",
  "coinbase_orders_edit",
  "coinbase_orders_get",
  "coinbase_orders_cancel",
  "coinbase_orders_fills",
  "coinbase_portfolios_list",
  "coinbase_portfolios_create",
  "coinbase_portfolios_get",
  "coinbase_portfolios_edit",
  "coinbase_portfolios_delete",
  "coinbase_products_list",
  "coinbase_products_get",
  "coinbase_products_ticker",
  "coinbase_products_book",
  "coinbase_products_candles",
  "coinbase_products_best_bid_ask",
  "coinbase_balance",
  "coinbase_transfer",
  "coinbase_fees",
]);

let toolDefinitions: Promise<CoinbaseMcpToolDefinition[]> | undefined;

async function availableTools(): Promise<CoinbaseMcpToolDefinition[]> {
  toolDefinitions ??= listCoinbaseMcpTools().catch((error) => {
    toolDefinitions = undefined;
    throw error;
  });
  return toolDefinitions;
}

function isNonSpotProduct(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /(?:^|[-_])(?:PERP|FUT(?:URE)?)(?:$|[-_])/iu.test(value);
}

function spotOnlyInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const productValues = [
    input.product_id,
    ...(Array.isArray(input.product_ids) ? input.product_ids : []),
    ...(typeof input.product_ids === "string"
      ? input.product_ids.split(",")
      : []),
  ];
  if (productValues.some(isNonSpotProduct)) {
    throw new Error("Eve's Coinbase access is restricted to spot products.");
  }

  if (
    toolName === "coinbase_products_list" ||
    toolName === "coinbase_orders_list" ||
    toolName === "coinbase_fees"
  ) {
    return { ...input, product_type: "SPOT" };
  }
  return input;
}

function nestedString(
  value: unknown,
  key: string,
  depth = 0,
): string | undefined {
  if (typeof value !== "object" || value === null || depth > 3) {
    return undefined;
  }
  const direct = Reflect.get(value, key);
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const wrapper of ["order", "product", "result"]) {
    const nested = nestedString(Reflect.get(value, wrapper), key, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

async function assertSpotOrderMutation(
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<void> {
  if (
    toolName !== "coinbase_orders_edit" &&
    toolName !== "coinbase_orders_cancel"
  ) {
    return;
  }

  const orderIds =
    toolName === "coinbase_orders_edit"
      ? [input.order_id]
      : Array.isArray(input.order_ids)
        ? input.order_ids
        : [];
  if (
    orderIds.length === 0 ||
    orderIds.length > 10 ||
    orderIds.some((orderId) => typeof orderId !== "string" || !orderId)
  ) {
    throw new Error(
      "Coinbase order mutations require between one and ten exact order IDs.",
    );
  }

  const checkedProducts = new Set<string>();
  for (const orderId of orderIds as string[]) {
    const order = await callCoinbaseMcpTool(
      "coinbase_orders_get",
      { order_id: orderId },
      { signal },
    );
    const productId = nestedString(order, "product_id");
    if (!productId) {
      throw new Error(
        "Coinbase did not return the product for an order mutation.",
      );
    }
    if (checkedProducts.has(productId)) continue;

    const product = await callCoinbaseMcpTool(
      "coinbase_products_get",
      { product_id: productId },
      { signal },
    );
    if (nestedString(product, "product_type")?.toUpperCase() !== "SPOT") {
      throw new Error(
        "Eve cannot edit or cancel a Coinbase order outside the spot market.",
      );
    }
    checkedProducts.add(productId);
  }
}

function toolDescription(definition: CoinbaseMcpToolDefinition): string {
  const effect = coinbaseToolRequiresApproval(definition.name)
    ? " This operation changes Coinbase state or moves funds and requires explicit user approval."
    : coinbaseToolIsPrivateRead(definition.name)
      ? " This reads private account data for the allowlisted owner without a separate approval prompt."
      : "";
  return `${definition.description ?? definition.name}${effect}`;
}

export default defineDynamic({
  events: {
    "step.started": async (_event, ctx) => {
      const principal = coinbasePrincipal(ctx.session);
      if (!principal || !coinbasePrincipalAllowed(principal)) return null;

      const definitions = (await availableTools()).filter((definition) =>
        ALLOWED_TOOLS.has(definition.name),
      );

      return Object.fromEntries(
        definitions.map((definition) => {
          const toolName = definition.name;
          const requiresApproval = coinbaseToolRequiresApproval(toolName);

          return [
            toolName,
            defineTool({
              description: toolDescription(definition),
              inputSchema: definition.inputSchema,
              approval: (approvalCtx) =>
                coinbaseApproval(approvalCtx, requiresApproval),
              async execute(input, toolCtx) {
                const authorizedPrincipal = requireCoinbaseAccess(toolCtx);
                const toolInput = spotOnlyInput(
                  toolName,
                  validateCoinbaseMcpInput(input),
                );
                await assertSpotOrderMutation(
                  toolName,
                  toolInput,
                  toolCtx.abortSignal,
                );
                const operation = () =>
                  callCoinbaseMcpTool(toolName, toolInput, {
                    signal: toolCtx.abortSignal,
                  });
                if (!coinbaseToolRequiresApproval(toolName)) return operation();
                return executeCoinbaseMutation({
                  callId: toolCtx.callId,
                  operation,
                  principalId: authorizedPrincipal.id,
                  toolInput,
                  toolName,
                });
              },
            }),
          ];
        }),
      );
    },
  },
});
