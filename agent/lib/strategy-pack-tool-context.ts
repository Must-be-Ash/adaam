import type { ToolContext } from "eve/tools";

import {
  photonIngressIdFromAuth,
} from "./photon-ingress-store";
import {
  deriveEveStrategyPackMutationIdentity,
} from "./strategy-pack-service";
import {
  requirePhotonWorkspaceToolScope,
} from "./workspace-runtime-scope";

function stringAttribute(
  attributes: Readonly<Record<string, string | readonly string[]>>,
  name: string,
): string | null {
  const value = attributes[name];
  return typeof value === "string" ? value : null;
}

export function requireStrategyPackToolContext(ctx: ToolContext) {
  const runtimeScope = requirePhotonWorkspaceToolScope(ctx);
  const auth = ctx.session.auth.current;
  const ingressId = photonIngressIdFromAuth(auth);
  const threadId = auth ? stringAttribute(auth.attributes, "thread_id") : null;
  const expectedRegistryRevision = Number(
    auth ? stringAttribute(auth.attributes, "photon_routing_revision") : null,
  );
  if (
    !auth ||
    !ingressId ||
    !threadId ||
    !Number.isSafeInteger(expectedRegistryRevision) ||
    expectedRegistryRevision < 0
  ) {
    throw new Error("strategy_pack_tool_scope_invalid");
  }
  return Object.freeze({
    expectedRegistryRevision,
    mutationIdentity: deriveEveStrategyPackMutationIdentity({
      ingressId,
      operationOrdinal: 0,
      stepId: ctx.callId,
      turnId: ctx.session.turn.id,
    }),
    principalId: auth.principalId,
    runtimeScope,
    threadId,
  });
}
