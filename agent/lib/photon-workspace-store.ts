import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import { photonApprovalGuardKey } from "#photon-approval-store";

const REGISTRY_KEY_PREFIX = "eve:photon:v1:workspace-registry:";
const MANAGER_KEY_PREFIX = "eve:photon:v1:workspace-manager:";
const MANAGER_TTL_SECONDS = 15 * 60;
const MAX_WORKSPACES = 12;
const MAX_CAS_ATTEMPTS = 5;

const COMPARE_AND_SET_SCRIPT = `
if KEYS[2] ~= "" and redis.call("GET", KEYS[2]) then
  return -1
end
if redis.call("GET", KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call("SET", KEYS[1], ARGV[2])
return 1
`;

const workspaceSchema = z.object({
  archivedAtMs: z.number().int().nonnegative().optional(),
  continuation: z.enum(["isolated", "physical"]),
  createdAtMs: z.number().int().nonnegative(),
  generation: z.number().int().positive(),
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  normalizedName: z.string().min(1).max(80),
  sessionId: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "archived"]),
  updatedAtMs: z.number().int().nonnegative(),
});

const registrySchema = z
  .object({
    activeWorkspaceId: z.string().uuid(),
    lastMutationId: z.string().uuid().optional(),
    revision: z.number().int().nonnegative(),
    schemaVersion: z.literal(1),
    workspaces: z.array(workspaceSchema).min(1).max(MAX_WORKSPACES),
  })
  .superRefine((registry, context) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    let activeWorkspaceFound = false;
    for (const workspace of registry.workspaces) {
      if (ids.has(workspace.id)) {
        context.addIssue({
          code: "custom",
          message: "Workspace IDs must be unique.",
        });
      }
      ids.add(workspace.id);
      if (names.has(workspace.normalizedName)) {
        context.addIssue({
          code: "custom",
          message: "Workspace names must be unique.",
        });
      }
      names.add(workspace.normalizedName);
      if (
        workspace.id === registry.activeWorkspaceId &&
        workspace.status === "active"
      ) {
        activeWorkspaceFound = true;
      }
    }
    if (!activeWorkspaceFound) {
      context.addIssue({
        code: "custom",
        message: "The active workspace must exist and not be archived.",
      });
    }
  });

const managerCapabilitySchema = z.object({
  createdAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
  principalId: z.string().min(1).max(300),
  schemaVersion: z.literal(1),
  threadId: z.string().min(1).max(500),
});

export type PhotonWorkspace = z.infer<typeof workspaceSchema>;

export interface PhotonWorkspaceState {
  activeWorkspace: PhotonWorkspace;
  revision: number;
  workspaces: PhotonWorkspace[];
}

export type PhotonWorkspaceAction =
  | {
      action: "archive";
      expectedRevision: number;
      replacementWorkspaceId?: string;
      workspaceId: string;
    }
  | {
      action: "create";
      expectedRevision: number;
      name: string;
      select?: boolean;
    }
  | {
      action: "rename";
      expectedRevision: number;
      name: string;
      workspaceId: string;
    }
  | {
      action: "restore";
      expectedRevision: number;
      workspaceId: string;
    }
  | {
      action: "select";
      expectedRevision: number;
      workspaceId: string;
    }
  | {
      action: "start-fresh";
      expectedRevision: number;
      workspaceId: string;
    };

export interface PhotonWorkspaceActionResult {
  retiredSessionId?: string;
  state: PhotonWorkspaceState;
}

export interface PhotonWorkspaceStoreClient {
  compareAndSet(
    key: string,
    expected: string,
    next: string,
    approvalGuardKey?: string,
  ): Promise<"blocked" | "conflict" | "swapped">;
  get(key: string): Promise<unknown>;
  set(
    key: string,
    value: string,
    options?: { ex?: number; nx?: true },
  ): Promise<unknown>;
}

export class PhotonWorkspaceConflictError extends Error {
  constructor() {
    super("The workspace state changed. Refresh and try again.");
    this.name = "PhotonWorkspaceConflictError";
  }
}

export class PhotonWorkspaceApprovalBlockedError extends Error {
  constructor() {
    super(
      "Finish or cancel the pending financial approval before changing workspaces.",
    );
    this.name = "PhotonWorkspaceApprovalBlockedError";
  }
}

export class PhotonWorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotonWorkspaceValidationError";
  }
}

let redisClient: Redis | undefined;
let redisStoreClient: PhotonWorkspaceStoreClient | undefined;

function redis(): Redis {
  if (redisClient) return redisClient;
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Photon workspace storage is not configured.");
  }
  redisClient = new Redis({
    automaticDeserialization: false,
    token,
    url,
  });
  return redisClient;
}

function store(): PhotonWorkspaceStoreClient {
  if (redisStoreClient) return redisStoreClient;
  const client = redis();
  let compareAndSetSha = client.scriptLoad(COMPARE_AND_SET_SCRIPT);
  const runCompareAndSet = async (
    key: string,
    expected: string,
    next: string,
    approvalGuardKey?: string,
  ): Promise<"blocked" | "conflict" | "swapped"> => {
    const keys = [key, approvalGuardKey ?? ""];
    const result = async (sha: string) =>
      client.evalsha<[string, string], number>(
        sha,
        keys,
        [expected, next],
      );
    let sha = await compareAndSetSha;
    try {
      const outcome = await result(sha);
      return outcome === 1
        ? "swapped"
        : outcome === -1
          ? "blocked"
          : "conflict";
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) {
        throw error;
      }
      compareAndSetSha = client.scriptLoad(COMPARE_AND_SET_SCRIPT);
      sha = await compareAndSetSha;
      const outcome = await result(sha);
      return outcome === 1
        ? "swapped"
        : outcome === -1
          ? "blocked"
          : "conflict";
    }
  };
  redisStoreClient = {
    compareAndSet: runCompareAndSet,
    get: (key) => client.get(key),
    set: (key, value, options) => {
      if (options?.nx && options.ex) {
        return client.set(key, value, { ex: options.ex, nx: true });
      }
      if (options?.nx) {
        return client.set(key, value, { nx: true });
      }
      if (options?.ex) {
        return client.set(key, value, { ex: options.ex });
      }
      return client.set(key, value);
    },
  };
  return redisStoreClient;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeHash(principalId: string, threadId: string): string {
  return sha256(`photon-workspaces\u0000${principalId}\u0000${threadId}`);
}

function registryKey(principalId: string, threadId: string): string {
  return `${REGISTRY_KEY_PREFIX}${scopeHash(principalId, threadId)}`;
}

function managerKey(token: string): string {
  return `${MANAGER_KEY_PREFIX}${sha256(token)}`;
}

function parseRegistry(value: unknown): z.infer<typeof registrySchema> {
  if (typeof value !== "string") {
    throw new Error("The Photon workspace registry is unavailable.");
  }
  return registrySchema.parse(JSON.parse(value));
}

function parseManagerCapability(
  value: unknown,
): z.infer<typeof managerCapabilitySchema> | null {
  if (typeof value !== "string") return null;
  try {
    const capability = managerCapabilitySchema.parse(JSON.parse(value));
    return capability.expiresAtMs > Date.now() ? capability : null;
  } catch {
    return null;
  }
}

function toState(
  registry: z.infer<typeof registrySchema>,
): PhotonWorkspaceState {
  const activeWorkspace = registry.workspaces.find(
    (workspace) => workspace.id === registry.activeWorkspaceId,
  );
  if (!activeWorkspace) {
    throw new Error("The active Photon workspace is unavailable.");
  }
  return {
    activeWorkspace,
    revision: registry.revision,
    workspaces: [...registry.workspaces].sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === "active" ? -1 : 1;
      }
      return left.createdAtMs - right.createdAtMs;
    }),
  };
}

function initialRegistry(): z.infer<typeof registrySchema> {
  const now = Date.now();
  const workspaceId = randomUUID();
  return registrySchema.parse({
    activeWorkspaceId: workspaceId,
    revision: 0,
    schemaVersion: 1,
    workspaces: [
      {
        continuation: "physical",
        createdAtMs: now,
        generation: 1,
        id: workspaceId,
        name: "Main",
        normalizedName: "main",
        status: "active",
        updatedAtMs: now,
      },
    ],
  });
}

async function ensureRegistry(
  input: { principalId: string; threadId: string },
  client: PhotonWorkspaceStoreClient,
): Promise<z.infer<typeof registrySchema>> {
  const key = registryKey(input.principalId, input.threadId);
  const existing = await client.get(key);
  if (existing !== null && existing !== undefined) {
    return parseRegistry(existing);
  }
  const initial = initialRegistry();
  await client.set(key, JSON.stringify(initial), { nx: true });
  return parseRegistry(await client.get(key));
}

async function mutateRegistry<T>(
  input: {
    approvalGuardKey?: string;
    expectedRevision?: number;
    principalId: string;
    threadId: string;
  },
  mutate: (
    registry: z.infer<typeof registrySchema>,
  ) => { registry: z.infer<typeof registrySchema>; value: T },
  client: PhotonWorkspaceStoreClient,
): Promise<{ registry: z.infer<typeof registrySchema>; value: T }> {
  const key = registryKey(input.principalId, input.threadId);
  const mutationId = randomUUID();
  await ensureRegistry(input, client);

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const raw = await client.get(key);
    const current = parseRegistry(raw);
    if (
      input.expectedRevision !== undefined &&
      current.revision !== input.expectedRevision
    ) {
      throw new PhotonWorkspaceConflictError();
    }
    const mutation = mutate(current);
    const next = registrySchema.parse({
      ...mutation.registry,
      lastMutationId: mutationId,
    });
    let outcome: Awaited<
      ReturnType<PhotonWorkspaceStoreClient["compareAndSet"]>
    >;
    try {
      outcome = await client.compareAndSet(
        key,
        String(raw),
        JSON.stringify(next),
        input.approvalGuardKey,
      );
    } catch (error) {
      try {
        const observed = parseRegistry(await client.get(key));
        if (observed.lastMutationId === mutationId) {
          return { registry: observed, value: mutation.value };
        }
      } catch {
        // The caller receives the original storage error.
      }
      throw error;
    }
    if (outcome === "swapped") {
      return { registry: next, value: mutation.value };
    }
    if (outcome === "blocked") {
      throw new PhotonWorkspaceApprovalBlockedError();
    }
    if (input.expectedRevision !== undefined) {
      const observed = parseRegistry(await client.get(key));
      if (observed.lastMutationId === mutationId) {
        return { registry: observed, value: mutation.value };
      }
      if (observed.revision !== input.expectedRevision) {
        throw new PhotonWorkspaceConflictError();
      }
    }
  }
  throw new PhotonWorkspaceConflictError();
}

function updatedRegistry(
  registry: z.infer<typeof registrySchema>,
  workspaces: PhotonWorkspace[],
  activeWorkspaceId = registry.activeWorkspaceId,
): z.infer<typeof registrySchema> {
  return {
    activeWorkspaceId,
    revision: registry.revision + 1,
    schemaVersion: 1,
    workspaces,
  };
}

export function normalizePhotonWorkspaceName(name: string): string {
  const normalized = name.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    [...normalized].length > 40 ||
    !/^[\p{L}\p{N}][\p{L}\p{N} &'().,_-]*$/u.test(normalized)
  ) {
    throw new PhotonWorkspaceValidationError(
      "Use a 1–40 character workspace name made of letters, numbers, spaces, and simple punctuation.",
    );
  }
  return normalized;
}

function normalizedName(name: string): string {
  return normalizePhotonWorkspaceName(name).toLocaleLowerCase("en-US");
}

export function findPhotonWorkspaceByName(
  state: PhotonWorkspaceState,
  name: string,
): PhotonWorkspace | null {
  const target = normalizedName(name);
  return (
    state.workspaces.find(
      (workspace) => workspace.normalizedName === target,
    ) ?? null
  );
}

export async function getPhotonWorkspaceState(
  input: { principalId: string; threadId: string },
  client: PhotonWorkspaceStoreClient = store(),
): Promise<PhotonWorkspaceState> {
  return toState(await ensureRegistry(input, client));
}

export async function createPhotonWorkspace(
  input: {
    approvalGuardKey?: string;
    expectedRevision?: number;
    name: string;
    principalId: string;
    select?: boolean;
    threadId: string;
  },
  client: PhotonWorkspaceStoreClient = store(),
): Promise<PhotonWorkspaceState> {
  const name = normalizePhotonWorkspaceName(input.name);
  const targetName = normalizedName(name);
  const now = Date.now();
  const workspace: PhotonWorkspace = {
    continuation: "isolated",
    createdAtMs: now,
    generation: 1,
    id: randomUUID(),
    name,
    normalizedName: targetName,
    status: "active",
    updatedAtMs: now,
  };
  const result = await mutateRegistry(
    input,
    (registry) => {
      if (registry.workspaces.length >= MAX_WORKSPACES) {
        throw new PhotonWorkspaceValidationError(
          `A conversation can have at most ${MAX_WORKSPACES} workspaces.`,
        );
      }
      if (
        registry.workspaces.some(
          (existing) => existing.normalizedName === targetName,
        )
      ) {
        throw new PhotonWorkspaceValidationError(
          `A workspace named “${name}” already exists.`,
        );
      }
      return {
        registry: updatedRegistry(
          registry,
          [...registry.workspaces, workspace],
          input.select ? workspace.id : registry.activeWorkspaceId,
        ),
        value: undefined,
      };
    },
    client,
  );
  return toState(result.registry);
}

export async function selectPhotonWorkspace(
  input: {
    approvalGuardKey?: string;
    expectedRevision?: number;
    principalId: string;
    threadId: string;
    workspaceId: string;
  },
  client: PhotonWorkspaceStoreClient = store(),
): Promise<PhotonWorkspaceState> {
  const result = await mutateRegistry(
    input,
    (registry) => {
      const workspace = registry.workspaces.find(
        (candidate) => candidate.id === input.workspaceId,
      );
      if (!workspace || workspace.status !== "active") {
        throw new PhotonWorkspaceValidationError(
          "That workspace is unavailable.",
        );
      }
      return {
        registry: updatedRegistry(
          registry,
          registry.workspaces,
          workspace.id,
        ),
        value: undefined,
      };
    },
    client,
  );
  return toState(result.registry);
}

export async function renamePhotonWorkspace(
  input: {
    approvalGuardKey?: string;
    expectedRevision?: number;
    name: string;
    principalId: string;
    threadId: string;
    workspaceId: string;
  },
  client: PhotonWorkspaceStoreClient = store(),
): Promise<PhotonWorkspaceState> {
  const name = normalizePhotonWorkspaceName(input.name);
  const targetName = normalizedName(name);
  const now = Date.now();
  const result = await mutateRegistry(
    input,
    (registry) => {
      const target = registry.workspaces.find(
        (workspace) => workspace.id === input.workspaceId,
      );
      if (!target) {
        throw new PhotonWorkspaceValidationError(
          "That workspace is unavailable.",
        );
      }
      if (
        registry.workspaces.some(
          (workspace) =>
            workspace.id !== target.id &&
            workspace.normalizedName === targetName,
        )
      ) {
        throw new PhotonWorkspaceValidationError(
          `A workspace named “${name}” already exists.`,
        );
      }
      return {
        registry: updatedRegistry(
          registry,
          registry.workspaces.map((workspace) =>
            workspace.id === target.id
              ? {
                  ...workspace,
                  name,
                  normalizedName: targetName,
                  updatedAtMs: now,
                }
              : workspace,
          ),
        ),
        value: undefined,
      };
    },
    client,
  );
  return toState(result.registry);
}

export async function archivePhotonWorkspace(
  input: {
    approvalGuardKey?: string;
    expectedRevision?: number;
    principalId: string;
    replacementWorkspaceId?: string;
    threadId: string;
    workspaceId: string;
  },
  client: PhotonWorkspaceStoreClient = store(),
): Promise<PhotonWorkspaceState> {
  const now = Date.now();
  const result = await mutateRegistry(
    input,
    (registry) => {
      const target = registry.workspaces.find(
        (workspace) => workspace.id === input.workspaceId,
      );
      if (!target || target.status !== "active") {
        throw new PhotonWorkspaceValidationError(
          "That workspace is unavailable.",
        );
      }
      const remaining = registry.workspaces.filter(
        (workspace) =>
          workspace.status === "active" && workspace.id !== target.id,
      );
      if (remaining.length === 0) {
        throw new PhotonWorkspaceValidationError(
          "Create another workspace before archiving the only active workspace.",
        );
      }
      let activeWorkspaceId = registry.activeWorkspaceId;
      if (target.id === registry.activeWorkspaceId) {
        const replacement = remaining.find(
          (workspace) => workspace.id === input.replacementWorkspaceId,
        );
        if (!replacement) {
          throw new PhotonWorkspaceValidationError(
            "Select a replacement before archiving the active workspace.",
          );
        }
        activeWorkspaceId = replacement.id;
      }
      return {
        registry: updatedRegistry(
          registry,
          registry.workspaces.map((workspace) =>
            workspace.id === target.id
              ? {
                  ...workspace,
                  archivedAtMs: now,
                  status: "archived" as const,
                  updatedAtMs: now,
                }
              : workspace,
          ),
          activeWorkspaceId,
        ),
        value: undefined,
      };
    },
    client,
  );
  return toState(result.registry);
}

export async function restorePhotonWorkspace(
  input: {
    approvalGuardKey?: string;
    expectedRevision?: number;
    principalId: string;
    threadId: string;
    workspaceId: string;
  },
  client: PhotonWorkspaceStoreClient = store(),
): Promise<PhotonWorkspaceState> {
  const now = Date.now();
  const result = await mutateRegistry(
    input,
    (registry) => {
      const target = registry.workspaces.find(
        (workspace) => workspace.id === input.workspaceId,
      );
      if (!target || target.status !== "archived") {
        throw new PhotonWorkspaceValidationError(
          "That workspace is not archived.",
        );
      }
      return {
        registry: updatedRegistry(
          registry,
          registry.workspaces.map((workspace) =>
            workspace.id === target.id
              ? {
                  ...workspace,
                  archivedAtMs: undefined,
                  status: "active" as const,
                  updatedAtMs: now,
                }
              : workspace,
          ),
        ),
        value: undefined,
      };
    },
    client,
  );
  return toState(result.registry);
}

export async function startFreshPhotonWorkspace(
  input: {
    approvalGuardKey?: string;
    expectedRevision?: number;
    principalId: string;
    threadId: string;
    workspaceId: string;
  },
  client: PhotonWorkspaceStoreClient = store(),
): Promise<PhotonWorkspaceActionResult> {
  const now = Date.now();
  const result = await mutateRegistry(
    input,
    (registry) => {
      const target = registry.workspaces.find(
        (workspace) => workspace.id === input.workspaceId,
      );
      if (!target || target.status !== "active") {
        throw new PhotonWorkspaceValidationError(
          "That workspace is unavailable.",
        );
      }
      return {
        registry: updatedRegistry(
          registry,
          registry.workspaces.map((workspace) =>
            workspace.id === target.id
              ? {
                  ...workspace,
                  continuation: "isolated" as const,
                  generation: workspace.generation + 1,
                  sessionId: undefined,
                  updatedAtMs: now,
                }
              : workspace,
          ),
        ),
        value: target.sessionId,
      };
    },
    client,
  );
  return {
    ...(result.value ? { retiredSessionId: result.value } : {}),
    state: toState(result.registry),
  };
}

export async function savePhotonWorkspaceSession(
  input: {
    generation: number;
    principalId: string;
    sessionId: string;
    threadId: string;
    workspaceId: string;
  },
  client: PhotonWorkspaceStoreClient = store(),
): Promise<boolean> {
  const now = Date.now();
  const result = await mutateRegistry(
    input,
    (registry) => {
      const target = registry.workspaces.find(
        (workspace) => workspace.id === input.workspaceId,
      );
      if (
        !target ||
        target.status !== "active" ||
        target.generation !== input.generation
      ) {
        return { registry, value: false };
      }
      return {
        registry: {
          ...registry,
          workspaces: registry.workspaces.map((workspace) =>
            workspace.id === target.id
              ? { ...workspace, sessionId: input.sessionId, updatedAtMs: now }
              : workspace,
          ),
        },
        value: true,
      };
    },
    client,
  );
  return result.value;
}

export async function mintPhotonWorkspaceManager(
  input: { principalId: string; threadId: string },
  client: PhotonWorkspaceStoreClient = store(),
): Promise<{ expiresAtMs: number; managerToken: string }> {
  await ensureRegistry(input, client);
  const managerToken = randomBytes(32).toString("base64url");
  const createdAtMs = Date.now();
  const expiresAtMs = createdAtMs + MANAGER_TTL_SECONDS * 1_000;
  const capability = managerCapabilitySchema.parse({
    createdAtMs,
    expiresAtMs,
    principalId: input.principalId,
    schemaVersion: 1,
    threadId: input.threadId,
  });
  await client.set(managerKey(managerToken), JSON.stringify(capability), {
    ex: MANAGER_TTL_SECONDS,
    nx: true,
  });
  return { expiresAtMs, managerToken };
}

async function resolveManagerCapability(
  managerToken: string,
  client: PhotonWorkspaceStoreClient,
): Promise<z.infer<typeof managerCapabilitySchema> | null> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(managerToken)) return null;
  return parseManagerCapability(await client.get(managerKey(managerToken)));
}

export async function getPhotonWorkspaceManagerState(
  managerToken: string,
  client: PhotonWorkspaceStoreClient = store(),
): Promise<PhotonWorkspaceState | null> {
  const capability = await resolveManagerCapability(managerToken, client);
  if (!capability) return null;
  return getPhotonWorkspaceState(capability, client);
}

export async function getPhotonWorkspaceManagerScope(
  managerToken: string,
  client: PhotonWorkspaceStoreClient = store(),
): Promise<{ principalId: string; threadId: string } | null> {
  const capability = await resolveManagerCapability(managerToken, client);
  if (!capability) return null;
  return {
    principalId: capability.principalId,
    threadId: capability.threadId,
  };
}

export async function applyPhotonWorkspaceManagerAction(
  managerToken: string,
  action: PhotonWorkspaceAction,
  client: PhotonWorkspaceStoreClient = store(),
): Promise<PhotonWorkspaceActionResult | null> {
  const capability = await resolveManagerCapability(managerToken, client);
  if (!capability) return null;
  const common = {
    approvalGuardKey: photonApprovalGuardKey(capability),
    expectedRevision: action.expectedRevision,
    principalId: capability.principalId,
    threadId: capability.threadId,
  };
  switch (action.action) {
    case "archive":
      return {
        state: await archivePhotonWorkspace(
          {
            ...common,
            ...(action.replacementWorkspaceId
              ? { replacementWorkspaceId: action.replacementWorkspaceId }
              : {}),
            workspaceId: action.workspaceId,
          },
          client,
        ),
      };
    case "create":
      return {
        state: await createPhotonWorkspace(
          {
            ...common,
            name: action.name,
            ...(action.select === undefined ? {} : { select: action.select }),
          },
          client,
        ),
      };
    case "rename":
      return {
        state: await renamePhotonWorkspace(
          {
            ...common,
            name: action.name,
            workspaceId: action.workspaceId,
          },
          client,
        ),
      };
    case "restore":
      return {
        state: await restorePhotonWorkspace(
          { ...common, workspaceId: action.workspaceId },
          client,
        ),
      };
    case "select":
      return {
        state: await selectPhotonWorkspace(
          { ...common, workspaceId: action.workspaceId },
          client,
        ),
      };
    case "start-fresh":
      return startFreshPhotonWorkspace(
        { ...common, workspaceId: action.workspaceId },
        client,
      );
  }
}
