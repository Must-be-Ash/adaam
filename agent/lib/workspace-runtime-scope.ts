import type { SessionContext } from "eve/context";
import { z } from "zod";

import {
  OwnerIdentityDeniedError,
  resolvePhotonOwnerConversationIdentity,
} from "./owner-identity";

const workspaceRuntimeScopeSchema = z.object({
  conversationId: z.string().regex(/^conversation_[a-f0-9]{64}$/u),
  generation: z.number().int().positive(),
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  schemaVersion: z.literal(1),
  workspaceId: z.string().uuid(),
});

export type WorkspaceRuntimeScope = Readonly<
  z.infer<typeof workspaceRuntimeScopeSchema>
>;

export class WorkspaceRuntimeScopeError extends Error {
  readonly code = "workspace_scope_invalid";

  constructor() {
    super("The authenticated workspace scope is missing or does not match.");
    this.name = "WorkspaceRuntimeScopeError";
  }
}

function invalid(): never {
  throw new WorkspaceRuntimeScopeError();
}

function stringAttribute(
  attributes: Readonly<Record<string, string | readonly string[]>>,
  name: string,
): string | undefined {
  const value = attributes[name];
  return typeof value === "string" ? value : undefined;
}

export function projectPhotonWorkspaceRuntimeScope(
  input: {
    generation: number;
    principalId: string;
    threadId: string;
    workspaceId: string;
  },
  environment: NodeJS.ProcessEnv = process.env,
): WorkspaceRuntimeScope {
  const identity = resolvePhotonOwnerConversationIdentity(input, environment);
  const parsed = workspaceRuntimeScopeSchema.safeParse({
    conversationId: identity.conversationId,
    generation: input.generation,
    ownerId: identity.ownerId,
    schemaVersion: 1,
    workspaceId: input.workspaceId,
  });
  if (!parsed.success) invalid();
  return Object.freeze(parsed.data);
}

export function workspaceRuntimeScopeAttributes(
  scope: WorkspaceRuntimeScope,
): Readonly<Record<string, string>> {
  return Object.freeze({
    conversation_id: scope.conversationId,
    owner_id: scope.ownerId,
    scope_version: String(scope.schemaVersion),
    workspace_generation: String(scope.generation),
    workspace_id: scope.workspaceId,
  });
}

export function requirePhotonWorkspaceToolScope(
  ctx: { readonly session: { readonly auth: SessionContext["session"]["auth"] } },
  expected: Partial<WorkspaceRuntimeScope> = {},
  environment: NodeJS.ProcessEnv = process.env,
): WorkspaceRuntimeScope {
  const auth = ctx.session.auth.current;
  if (
    !auth ||
    auth.authenticator !== "photon-imessage-webhook" ||
    auth.principalType !== "user" ||
    stringAttribute(auth.attributes, "channel") !== "photon"
  ) {
    invalid();
  }

  const threadId = stringAttribute(auth.attributes, "thread_id");
  const generation = Number(
    stringAttribute(auth.attributes, "workspace_generation"),
  );
  const parsed = workspaceRuntimeScopeSchema.safeParse({
    conversationId: stringAttribute(auth.attributes, "conversation_id"),
    generation,
    ownerId: stringAttribute(auth.attributes, "owner_id"),
    schemaVersion: Number(stringAttribute(auth.attributes, "scope_version")),
    workspaceId: stringAttribute(auth.attributes, "workspace_id"),
  });
  if (!threadId || !parsed.success) invalid();

  let identity;
  try {
    identity = resolvePhotonOwnerConversationIdentity(
      { principalId: auth.principalId, threadId },
      environment,
    );
  } catch (error) {
    if (error instanceof OwnerIdentityDeniedError) invalid();
    throw error;
  }
  if (
    parsed.data.ownerId !== identity.ownerId ||
    parsed.data.conversationId !== identity.conversationId
  ) {
    invalid();
  }
  for (const [key, value] of Object.entries(expected)) {
    if (parsed.data[key as keyof WorkspaceRuntimeScope] !== value) invalid();
  }
  return Object.freeze(parsed.data);
}
