import assert from "node:assert/strict";

import { deliverWorkspaceOutcomeToPhoton } from "../agent/lib/workspace-alert-dispatch";
import { stageWorkspaceAlertPresentations } from "../agent/lib/workspace-worker-control-plane";
import {
  readWorkspaceAlert,
  stageWorkspaceAlert,
  type WorkspaceAlertStoreClient,
} from "../agent/lib/workspace-alert-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import type { WorkspaceFinding, WorkspaceRunOutcome } from "../agent/lib/workspace-finding-store";
import type { ClaimedWorkspaceMonitor, WorkspaceMonitor } from "../agent/lib/workspace-monitor-store";

/*
 * A committed finding whose alert never reaches the owner is the worst failure
 * this system has: the occurrence spends real money, the source cursor advances
 * past the statement, and the alert is gone for good. It happened in production
 * for every commentary occurrence and no test caught it, because the only
 * coverage of delivery hands `deliverWorkspaceAlertToPhoton` an alert built in
 * memory. Nothing exercised commit -> store -> read -> deliver as one path.
 *
 * This does. It stages alerts through the same helper the worker's commit paths
 * call, then delivers the outcome through the real dispatch, so the store key
 * written by staging has to be the key the lookup reads.
 */

class MemoryStore implements WorkspaceAlertStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string, next: string) {
    if (this.values.get(key) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async createOrRead(key: string, value: string) {
    const existing = this.values.get(key);
    if (existing) return existing;
    this.values.set(key, value);
    return value;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

const environment = { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" };
const scope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
}, environment);
const now = new Date("2026-08-23T05:00:00.000Z");
const monitorId = "323e4567-e89b-42d3-a456-426614174000";

const finding = {
  accessClassification: "public",
  artifactRefs: [],
  asOf: now.toISOString(),
  contentHash: "a".repeat(64),
  findingId: `finding_${"c".repeat(64)}`,
  monitorId,
  ownerId: scope.ownerId,
  provenance: [{
    accessClassification: "public",
    canonicalUrl: "https://x.com/KobeissiLetter/status/1",
    origin: "https://api.x.com",
    role: "official",
    sourceId: "x-public-commentary-user.3316376038.KobeissiLetter",
  }],
  recordType: "workspace_finding",
  runId: "run_fixture",
  schemaVersion: 1,
  state: "committed",
  summary: "A material public statement was classified as impactful.",
  workspaceId: scope.workspaceId,
} satisfies WorkspaceFinding;

const monitor = {
  configurationRevision: 1,
  consecutiveFailures: 0,
  createdAt: now.toISOString(),
  deliverySubscriptionId: "subscription.photon.fixture",
  endAt: null,
  instruction: "Track public commentary.",
  lastCompletedAt: null,
  lastErrorCode: null,
  lastRunAt: null,
  lifecycleState: "enabled",
  monitorId,
  name: "Public commentary tracker",
  nextOccurrenceAt: now.toISOString(),
  ownerId: scope.ownerId,
  pauseReason: null,
  pausedAt: null,
  requiredCapabilityIds: [],
  schedule: { at: now.toISOString(), kind: "one_time" },
  schemaVersion: 1,
  sourceCheckpoint: { contentDigest: null, watermark: null },
  sources: [{
    accessClassification: "public",
    canonicalUrl: "https://api.x.com/2/users/3316376038/tweets",
    origin: "https://api.x.com",
    sourceId: "x-public-commentary-user.3316376038.KobeissiLetter",
  }],
  tighteningLimits: { inputTokensPerRun: null, outputTokensPerRun: null, paidPerRun: null },
  updatedAt: now.toISOString(),
  workspaceBindingImmutable: true,
  workspaceId: scope.workspaceId,
} satisfies WorkspaceMonitor;

const outcome = {
  finding,
  monitorId,
  ownerId: scope.ownerId,
  workspaceId: scope.workspaceId,
} as unknown as WorkspaceRunOutcome;
const job = { monitor, scope } as unknown as ClaimedWorkspaceMonitor;
const subscription = {
  destination: "private-photon-thread",
  ownerId: scope.ownerId,
  principalId: "principal_fixture",
  subscriptionId: monitor.deliverySubscriptionId,
  threadId: "thread_fixture",
} as unknown as Awaited<
  ReturnType<typeof import("../agent/lib/photon-alert-subscription-store")
    .readPhotonAlertDeliverySubscription>
>;

async function deliver(client: WorkspaceAlertStoreClient) {
  const delivered: string[] = [];
  await deliverWorkspaceOutcomeToPhoton({
    clients: {
      alert: client,
      deliver: async ({ alert, send }) => {
        await send({ discussUrl: "https://example.invalid/#t" } as never);
        delivered.push(alert.alertId);
        return { deliveryId: "delivery_fixture", state: "delivered" } as never;
      },
      readSubscription: async () => subscription,
      send: async () => ({ accepted: true }),
    },
    job,
    outcome,
  });
  return delivered;
}

// The commentary shape: several presentations for one finding.
const presentations = [
  { key: "executive", title: "Kobeissi: material move", whyMatched: "Impact 62." },
  { key: "compact", title: "Kobeissi", whyMatched: "Impact 62." },
] as const;

const staged = new MemoryStore();
await stageWorkspaceAlertPresentations({
  alertPresentations: presentations,
  finding,
  monitor,
  now,
  scope,
}, staged);

const readBack = await readWorkspaceAlert(scope, finding.findingId, staged);
assert.ok(
  readBack,
  "an alert staged by the commit path must be resolvable by finding id - " +
    "delivery has no other way to find it",
);
assert.equal(readBack.title, presentations[0].title);
assert.deepEqual(
  await deliver(staged),
  [readBack.alertId],
  "the outcome's alert must be delivered exactly once",
);

/*
 * An eligible finding with an EMPTY presentation list must still get an alert.
 * `input.alertPresentations ?? [null]` lets `[]` through untouched, so the
 * staging loop never ran and the occurrence committed a finding with no alert
 * at all - inside a branch already guarded by `if (outcome.finding)`. The only
 * reason the owner saw anything was the replay path staging a bare fallback
 * afterwards, which is how a tracker alert arrived reading
 * "3 validated public-commentary research candidates" plus raw digests instead
 * of the rationale the vertical had already built.
 */
const emptyPresentations = new MemoryStore();
await stageWorkspaceAlertPresentations({
  alertPresentations: [],
  finding,
  monitor,
  now,
  scope,
}, emptyPresentations);
const fromEmpty = await readWorkspaceAlert(scope, finding.findingId, emptyPresentations);
assert.ok(
  fromEmpty,
  "a finding with an empty presentation list must still stage a deliverable alert",
);
assert.deepEqual(
  await deliver(emptyPresentations),
  [fromEmpty.alertId],
  "and that alert must deliver rather than be silently dropped",
);

/*
 * Red guard. This is the state production was in: every presentation keyed, so
 * `readWorkspaceAlert` - which digests the finding id alone - finds nothing and
 * the occurrence dies as workspace_alert_unavailable after having committed.
 * If the unkeyed-first rule regresses, the assertion above goes red and this
 * one documents exactly what that regression looks like.
 */
const allKeyed = new MemoryStore();
for (const presentation of presentations) {
  await stageWorkspaceAlert({
    finding, monitor, now, presentation, presentationKey: presentation.key, scope,
  }, allKeyed);
}
assert.equal(
  await readWorkspaceAlert(scope, finding.findingId, allKeyed),
  null,
  "keying every presentation is what made the alert unreachable",
);
await assert.rejects(
  deliver(allKeyed),
  /workspace_alert_unavailable/u,
  "an unreachable alert must fail loudly, not silently drop",
);

console.info("Workspace alert dispatch seam verification passed.");
