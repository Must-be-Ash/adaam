import type { SessionContext } from "eve/context";
import { z } from "zod";

import {
  requirePhotonOwnerAccess,
  type OwnerResourceKind,
} from "./owner-identity";
import {
  requirePhotonWorkspaceToolScope,
  type WorkspaceRuntimeScope,
} from "./workspace-runtime-scope";

const workspaceIdSchema = z.string().uuid();
const ownerIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u);
const authorizedScopes = new WeakSet<object>();

export interface AuthorizedWorkspaceStoreScope {
  readonly ownerId: string;
  readonly workspaceId: string;
}

export class WorkspaceStoreAuthorizationError extends Error {
  readonly code = "workspace_scope_forbidden";

  constructor() {
    super("An authoritative owner and workspace scope is required.");
    this.name = "WorkspaceStoreAuthorizationError";
  }
}

function forbidden(): never {
  throw new WorkspaceStoreAuthorizationError();
}

function mint(input: {
  ownerId: string;
  workspaceId: string;
}): AuthorizedWorkspaceStoreScope {
  const parsed = z
    .object({ ownerId: ownerIdSchema, workspaceId: workspaceIdSchema })
    .strict()
    .safeParse(input);
  if (!parsed.success) forbidden();
  const scope = Object.freeze(parsed.data);
  authorizedScopes.add(scope);
  return scope;
}

export function authorizePhotonWorkspaceToolStore(
  ctx: Pick<SessionContext, "session">,
  expected: Partial<WorkspaceRuntimeScope> = {},
  environment: NodeJS.ProcessEnv = process.env,
): AuthorizedWorkspaceStoreScope {
  const scope = requirePhotonWorkspaceToolScope(ctx, expected, environment);
  return mint({ ownerId: scope.ownerId, workspaceId: scope.workspaceId });
}

export function authorizePhotonWorkspaceControlPlaneStore(
  input: {
    principalId: string;
    resource: Extract<OwnerResourceKind, "alert" | "manager" | "worker">;
    workspaceId: string;
  },
  environment: NodeJS.ProcessEnv = process.env,
): AuthorizedWorkspaceStoreScope {
  const owner = requirePhotonOwnerAccess(
    { principalId: input.principalId, resource: input.resource },
    environment,
  );
  return mint({ ownerId: owner.ownerId, workspaceId: input.workspaceId });
}

export function assertAuthorizedWorkspaceStoreScope(
  scope: AuthorizedWorkspaceStoreScope,
): void {
  if (
    typeof scope !== "object" ||
    scope === null ||
    !authorizedScopes.has(scope)
  ) {
    forbidden();
  }
}
