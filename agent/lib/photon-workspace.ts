import type { Thread } from "chat";

import type {
  PhotonWorkspace,
  PhotonWorkspaceState,
} from "./photon-workspace-store";

const WORKSPACE_THREAD_MARKER = ":eve-workspace:v1:";
const WORKSPACE_SUFFIX =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(\d+)$/iu;

const THREAD_ID_METHODS = new Set<PropertyKey>([
  "addReaction",
  "channelIdFromThreadId",
  "decodeThreadId",
  "deleteMessage",
  "editMessage",
  "editObject",
  "fetchMessage",
  "fetchMessages",
  "fetchThread",
  "getChannelVisibility",
  "isDM",
  "onThreadSubscribe",
  "postEphemeral",
  "postMessage",
  "postObject",
  "removeReaction",
  "scheduleMessage",
  "startTyping",
  "stream",
]);

export function isPhotonSessionManagerRequest(text: string): boolean {
  const request = text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
  if (
    /^(?:sessions?|workspaces?|session manager|workspace manager|session settings|workspace settings|(?:current|active) (?:session|workspace))$/u.test(
      request,
    ) ||
    /^(?:reset session|start fresh)$/u.test(request) ||
    /^(?:manage|show|open|list|view|check)(?: me)?(?: my| the| all| current)? (?:sessions?|workspaces?|session manager|workspace manager)$/u.test(
      request,
    ) ||
    /^(?:what|which) (?:session|workspace) (?:am i|are we) (?:currently )?(?:in|on|using)$/u.test(
      request,
    ) ||
    /^(?:what|which) is (?:my|the|our) (?:current |active )?(?:session|workspace)$/u.test(
      request,
    )
  ) {
    return true;
  }
  if (
    /\b(?:sessions?|workspaces?)\b/u.test(request) &&
    /\b(?:active|another|archive|change|clear|create|current|different|list|manage|new|open|remove|rename|reset|restore|select|separate|show|start|switch|use|view|what|where|which)\b/u.test(
      request,
    )
  ) {
    return true;
  }
  return (
    /\b(?:create|start|open|add|make)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:session|workspace|conversation|chat|context)\b/u.test(
      request,
    ) ||
    /\b(?:want|need)\s+(?:to\s+)?(?:create\s+)?(?:a\s+)?(?:new|different|separate)\s+(?:session|workspace|conversation|chat|context)\b/u.test(
      request,
    ) ||
    /\b(?:switch|change|move|go|use|select)\s+(?:me\s+)?(?:to\s+)?(?:a\s+|the\s+)?(?:new\s+|different\s+|another\s+)?(?:session|workspace|conversation|chat|context)\b/u.test(
      request,
    ) ||
    /\b(?:rename|archive|restore|delete|remove|reset|clear|manage)\s+(?:my\s+|the\s+|this\s+|current\s+)?(?:session|workspace|conversation|chat|context)\b/u.test(
      request,
    )
  );
}

export function physicalPhotonThreadId(threadId: string): string {
  const markerIndex = threadId.lastIndexOf(WORKSPACE_THREAD_MARKER);
  if (markerIndex < 0) return threadId;
  const suffix = threadId.slice(markerIndex + WORKSPACE_THREAD_MARKER.length);
  return WORKSPACE_SUFFIX.test(suffix)
    ? threadId.slice(0, markerIndex)
    : threadId;
}

export function parsePhotonWorkspaceThreadId(
  threadId: string,
): { generation: number; workspaceId: string } | null {
  const markerIndex = threadId.lastIndexOf(WORKSPACE_THREAD_MARKER);
  if (markerIndex < 0) return null;
  const match = threadId
    .slice(markerIndex + WORKSPACE_THREAD_MARKER.length)
    .match(WORKSPACE_SUFFIX);
  if (!match?.[1] || !match[2]) return null;
  const generation = Number(match[2]);
  return Number.isSafeInteger(generation) && generation > 0
    ? { generation, workspaceId: match[1].toLowerCase() }
    : null;
}

export function photonWorkspaceThreadId(
  physicalThreadId: string,
  workspace: Pick<
    PhotonWorkspace,
    "continuation" | "generation" | "id"
  >,
): string {
  const physical = physicalPhotonThreadId(physicalThreadId);
  return workspace.continuation === "physical"
    ? physical
    : `${physical}${WORKSPACE_THREAD_MARKER}${workspace.id}:${workspace.generation}`;
}

export function photonWorkspaceThread(
  thread: Thread,
  workspace: Pick<
    PhotonWorkspace,
    "continuation" | "generation" | "id"
  >,
): ReturnType<Thread["toJSON"]> {
  const serialized = thread.toJSON();
  const id = photonWorkspaceThreadId(thread.id, workspace);
  return {
    ...serialized,
    id,
    ...(serialized.currentMessage
      ? {
          currentMessage: {
            ...serialized.currentMessage,
            threadId: id,
          },
        }
      : {}),
  };
}

export function photonWorkspaceContext(workspace: PhotonWorkspace): string {
  return (
    `This private iMessage turn is routed to the isolated session ${JSON.stringify(workspace.name)}. ` +
    "Use only this session's history and do not infer context from other sessions. Do not mention its name or routing metadata unless the user asks."
  );
}

export function photonApprovalWorkspace(
  state: PhotonWorkspaceState,
  binding: {
    sessionId: string;
    workspaceGeneration?: number;
    workspaceId?: string;
  },
): PhotonWorkspace | null {
  if (
    (binding.workspaceId === undefined) !==
    (binding.workspaceGeneration === undefined)
  ) {
    return null;
  }
  const workspace =
    binding.workspaceId && binding.workspaceGeneration
      ? state.workspaces.find(
          (candidate) =>
            candidate.id === binding.workspaceId &&
            candidate.generation === binding.workspaceGeneration,
        )
      : state.workspaces.find(
          (candidate) => candidate.sessionId === binding.sessionId,
        ) ??
        (state.activeWorkspace.continuation === "physical"
          ? state.activeWorkspace
          : undefined);
  return workspace?.status === "active" &&
    workspace.id === state.activeWorkspace.id
    ? workspace
    : null;
}

export function workspaceAwarePhotonAdapter<T extends object>(adapter: T): T {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (!THREAD_ID_METHODS.has(property)) {
        return value.bind(target);
      }
      return (threadId: unknown, ...args: unknown[]) =>
        value.call(
          target,
          typeof threadId === "string"
            ? physicalPhotonThreadId(threadId)
            : threadId,
          ...args,
        );
    },
  });
}
