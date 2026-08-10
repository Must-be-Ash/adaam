import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

import { coinbaseCredentials } from "./coinbase-cli";

const decimalSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, "Use a positive decimal string.")
  .refine(
    (value) => Number.isFinite(Number(value)) && Number(value) > 0,
    "Amount must be a finite number greater than zero.",
  );

const productIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/u,
    "Use a product such as BTC-USD or ETH-USDC.",
  );

const orderShape = {
  baseSize: decimalSchema.optional(),
  limitPrice: decimalSchema.optional(),
  productId: productIdSchema,
  quoteSize: decimalSchema.optional(),
  side: z.enum(["BUY", "SELL"]),
  stopDirection: z.enum(["up", "down"]).optional(),
  stopPrice: decimalSchema.optional(),
  type: z.enum(["market", "limit", "stop_limit"]),
} as const;

function validateOrder(
  value: {
    baseSize?: string;
    limitPrice?: string;
    quoteSize?: string;
    side: "BUY" | "SELL";
    stopDirection?: "up" | "down";
    stopPrice?: string;
    type: "market" | "limit" | "stop_limit";
  },
  ctx: z.RefinementCtx,
): void {
  if (value.baseSize && value.quoteSize) {
    ctx.addIssue({
      code: "custom",
      message: "Use exactly one size field.",
      path: ["quoteSize"],
    });
  }

  if (value.type === "market") {
    if (value.side === "BUY" && (!value.quoteSize || value.baseSize)) {
      ctx.addIssue({
        code: "custom",
        message: "A market BUY requires quoteSize and must not include baseSize.",
        path: ["quoteSize"],
      });
    }
    if (value.side === "SELL" && (!value.baseSize || value.quoteSize)) {
      ctx.addIssue({
        code: "custom",
        message: "A market SELL requires baseSize and must not include quoteSize.",
        path: ["baseSize"],
      });
    }
    if (value.limitPrice || value.stopPrice || value.stopDirection) {
      ctx.addIssue({
        code: "custom",
        message: "Market orders cannot include limit or stop fields.",
        path: ["type"],
      });
    }
    return;
  }

  if (!value.baseSize || value.quoteSize) {
    ctx.addIssue({
      code: "custom",
      message: "Limit and stop-limit orders require baseSize only.",
      path: ["baseSize"],
    });
  }
  if (!value.limitPrice) {
    ctx.addIssue({
      code: "custom",
      message: "Limit and stop-limit orders require limitPrice.",
      path: ["limitPrice"],
    });
  }

  if (value.type === "stop_limit") {
    if (!value.stopPrice) {
      ctx.addIssue({
        code: "custom",
        message: "A stop-limit order requires stopPrice.",
        path: ["stopPrice"],
      });
    }
    if (!value.stopDirection) {
      ctx.addIssue({
        code: "custom",
        message: "A stop-limit order requires stopDirection.",
        path: ["stopDirection"],
      });
    }
  } else if (value.stopPrice || value.stopDirection) {
    ctx.addIssue({
      code: "custom",
      message: "A limit order cannot include stop fields.",
      path: ["type"],
    });
  }
}

export const coinbaseOrderSchema = z
  .object(orderShape)
  .strict()
  .superRefine(validateOrder);

export const coinbaseCreateOrderSchema = z
  .object({
    ...orderShape,
    previewToken: z.string().min(40).max(4_096),
  })
  .strict()
  .superRefine(validateOrder);

export type CoinbaseOrder = z.infer<typeof coinbaseOrderSchema>;

interface PreviewPayload {
  expiresAtMs: number;
  nonce: string;
  order: CoinbaseOrder;
  principalHash: string;
  version: 1;
}

const previewPayloadSchema = z.object({
  expiresAtMs: z.number().int().positive(),
  nonce: z.string().uuid(),
  order: coinbaseOrderSchema,
  principalHash: z.string().regex(/^[a-f0-9]{64}$/u),
  version: z.literal(1),
});

function canonicalOrder(order: CoinbaseOrder): CoinbaseOrder {
  return {
    productId: order.productId,
    side: order.side,
    type: order.type,
    ...(order.quoteSize ? { quoteSize: order.quoteSize } : {}),
    ...(order.baseSize ? { baseSize: order.baseSize } : {}),
    ...(order.limitPrice ? { limitPrice: order.limitPrice } : {}),
    ...(order.stopPrice ? { stopPrice: order.stopPrice } : {}),
    ...(order.stopDirection ? { stopDirection: order.stopDirection } : {}),
  };
}

function sign(encoded: string): Buffer {
  return createHmac(
    "sha256",
    coinbaseCredentials().keySecret,
  )
    .update("eve-coinbase-order-preview\u0000")
    .update(encoded)
    .digest();
}

function principalHash(principalId: string): string {
  return createHash("sha256")
    .update("eve-coinbase-principal\u0000")
    .update(principalId)
    .digest("hex");
}

export function createOrderPreviewToken(
  order: CoinbaseOrder,
  principalId: string,
): { expiresAt: string; token: string } {
  const expiresAtMs = Date.now() + 5 * 60_000;
  const payload: PreviewPayload = {
    expiresAtMs,
    nonce: randomUUID(),
    order: canonicalOrder(order),
    principalHash: principalHash(principalId),
    version: 1,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encoded).toString("base64url");
  return {
    expiresAt: new Date(expiresAtMs).toISOString(),
    token: `${encoded}.${signature}`,
  };
}

export function verifyOrderPreviewToken(
  token: string,
  order: CoinbaseOrder,
  principalId: string,
): void {
  const [encoded, suppliedSignature, ...extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra.length > 0) {
    throw new Error("The Coinbase order preview token is malformed.");
  }

  const expectedSignature = sign(encoded);
  const supplied = Buffer.from(suppliedSignature, "base64url");
  if (
    supplied.length !== expectedSignature.length ||
    !timingSafeEqual(supplied, expectedSignature)
  ) {
    throw new Error("The Coinbase order preview token is invalid.");
  }

  let payload: PreviewPayload;
  try {
    payload = previewPayloadSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    throw new Error("The Coinbase order preview token is invalid.");
  }

  if (payload.expiresAtMs < Date.now()) {
    throw new Error(
      "The Coinbase order preview expired. Request a fresh preview before trading.",
    );
  }
  if (payload.expiresAtMs > Date.now() + 10 * 60_000) {
    throw new Error("The Coinbase order preview expiry is invalid.");
  }
  if (payload.principalHash !== principalHash(principalId)) {
    throw new Error(
      "The Coinbase order preview belongs to a different private-chat identity.",
    );
  }
  if (
    JSON.stringify(canonicalOrder(payload.order)) !==
    JSON.stringify(canonicalOrder(order))
  ) {
    throw new Error(
      "The order changed after preview. Request a fresh preview for the exact order.",
    );
  }
}

export function clientOrderIdForPreview(token: string): string {
  const bytes = createHash("sha256")
    .update("eve-coinbase-order\u0000")
    .update(token)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function orderMcpInput(
  order: CoinbaseOrder,
  clientOrderId?: string,
): Record<string, unknown> {
  return {
    product_id: order.productId,
    side: order.side,
    type: order.type,
    ...(order.quoteSize ? { quote_size: order.quoteSize } : {}),
    ...(order.baseSize ? { base_size: order.baseSize } : {}),
    ...(order.limitPrice ? { limit_price: order.limitPrice } : {}),
    ...(order.stopPrice ? { stop_price: order.stopPrice } : {}),
    ...(order.stopDirection
      ? { stop_direction: order.stopDirection }
      : {}),
    ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
  };
}
