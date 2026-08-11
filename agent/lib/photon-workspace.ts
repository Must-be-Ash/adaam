import type { Thread } from "chat";

import type { PhotonWorkspace } from "./photon-workspace-store";

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
    `This private iMessage turn is routed to the isolated workspace ${JSON.stringify(workspace.name)}. ` +
    "Use only this workspace's session history and do not infer context from other workspaces."
  );
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
