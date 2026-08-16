import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import {
  CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
  CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1,
  CONGRESSIONAL_POLICY_V1,
  CONGRESSIONAL_SECURITY_CATALOG_V1,
} from "../agent/lib/congressional-reference-catalog";
import { congressionalSignalsExecutionEnabled } from "../agent/lib/congressional-signal-flags";
import {
  deriveHouseStrategyTransactionRevisionId,
  houseStrategyTransactionSchema,
} from "../agent/lib/congressional-signal-schema";
import {
  evaluateCongressionalFiling,
  evaluateCongressionalTransaction,
} from "../agent/lib/congressional-strategy";
import {
  persistCongressionalFilingEvaluation,
  readCongressionalFilingSignal,
  type CongressionalSignalStoreClient,
} from "../agent/lib/congressional-signal-store";
import type { PublicSourceAcquisitionStoreClient } from "../agent/lib/public-source-acquisition-store";
import {
  runHousePublicSourceAcquisition,
  type HousePublicSourceBinaryResponse,
} from "../agent/lib/house-public-source-adapter";
import { publicSourceSubscriptionSchema } from "../agent/lib/public-source-adapter-schema";
import {
  derivePublicSourceSubscriptionId,
  ensurePublicSourceSubscription,
  projectPublicSourceAcquisition,
  type PublicSourceSubscriptionStoreClient,
} from "../agent/lib/public-source-subscription-store";
import {
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  STRATEGY_PACK_CAPABILITY_INVENTORY,
} from "../agent/lib/strategy-pack-reference-catalog";
import { workspaceFindingCandidateSchema } from "../agent/lib/workspace-finding-store";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryStore implements
  PublicSourceAcquisitionStoreClient,
  PublicSourceSubscriptionStoreClient,
  CongressionalSignalStoreClient {
  readonly records = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string): Promise<boolean> {
    const current = this.records.get(key) ?? null;
    if (current !== expected) return false;
    this.records.set(key, next);
    return true;
  }

  async createOrRead(key: string, value: string): Promise<{ created: boolean; value: unknown }> {
    const current = this.records.get(key);
    if (current !== undefined) return { created: false, value: current };
    this.records.set(key, value);
    return { created: true, value };
  }

  async get(key: string): Promise<unknown> {
    return this.records.get(key) ?? null;
  }
}

const root = new URL("./fixtures/public-source-adapters/house/", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("live-review-2026-08-16/manifest.json", root), "utf8"),
) as { readonly documents: readonly {
  readonly disclosedFiler: {
    readonly firstName: string;
    readonly lastName: string;
    readonly prefix: string | null;
    readonly stateDistrict: string;
    readonly suffix: string | null;
  };
  readonly docId: string;
  readonly filingDate: string;
  readonly retainedFile: string;
}[] };
const policyFixtures = JSON.parse(
  await readFile(new URL("../../congressional-signals/sprint-1-policy.json", root), "utf8"),
) as { readonly scenarios: readonly { readonly id: string }[] };
assert.deepEqual(
  policyFixtures.scenarios.map(({ id }) => id),
  ["baseline", "broad-fund", "duplicate", "forbidden-capability", "priority", "retained-official-multi-row", "stale", "unresolved"],
);
const retained = manifest.documents.find((document) => document.retainedFile === "ptr-10.pdf")!;
const observedAt = "2026-08-16T18:00:00.000Z";
const sourceUrl = (docId: string) =>
  `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/${docId}.pdf`;
const response = (body: Uint8Array, contentType: string, url: string): HousePublicSourceBinaryResponse => ({
  body,
  contentType,
  finalUrl: url,
  observedAt,
  requestedUrl: url,
  status: 200,
});
async function zipHouseIndex(xml: string): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("2026FD.xml", new TextReader(xml));
  return writer.close();
}

const [year, month, day] = retained.filingDate.split("-");
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FinancialDisclosure><Member><Prefix>${retained.disclosedFiler.prefix ?? ""}</Prefix><Last>${retained.disclosedFiler.lastName}</Last><First>${retained.disclosedFiler.firstName}</First><Suffix>${retained.disclosedFiler.suffix ?? ""}</Suffix><FilingType>P</FilingType><StateDst>${retained.disclosedFiler.stateDistrict}</StateDst><Year>2026</Year><FilingDate>${month}/${day}/${year}</FilingDate><DocID>${retained.docId}</DocID></Member></FinancialDisclosure>`;
const indexBody = await zipHouseIndex(xml);
const pdfBody = new Uint8Array(await readFile(
  new URL(`live-review-2026-08-16/${retained.retainedFile}`, root),
));
const store = new MemoryStore();
const acquisition = await runHousePublicSourceAcquisition({
  client: store,
  fetchDocument: async (url) => response(pdfBody, "application/pdf", url),
  fetchIndex: async (url) => response(indexBody, "application/zip", url),
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: { startAt: "2026-08-16T12:00:00.000Z", endAt: observedAt },
});
const workspaceId = "123e4567-e89b-42d3-a456-426614174300";
const scope = authorizeDeploymentWorkspaceStore(
  { ownerId: "owner_fixture", workspaceId },
  { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" },
);
const monitorId = "7dd4968b-3cf6-4ac3-a36a-9567b9b71234";
const sourceInstance = acquisition.commit!.sourceInstance;
const subscriptionId = derivePublicSourceSubscriptionId({
  monitorId,
  sourceInstanceId: sourceInstance.sourceInstanceId,
  workspaceId,
});
const packBinding = {
  bindingRevision: 1,
  packContentDigest: "a".repeat(64),
  packId: "congressional-signals" as const,
  packVersion: "1.0.0" as const,
};
await ensurePublicSourceSubscription(scope, publicSourceSubscriptionSchema.parse({
  adapterDefinitionDigest: sourceInstance.adapterDefinitionDigest,
  adapterVersion: sourceInstance.adapterVersion,
  deliveryCursor: { lastAcquisitionId: null, revision: 0 },
  factSchemaVersions: ["house-ptr-filing/v1", "house-ptr-transaction/v1"],
  filter: { kind: "all" },
  lifecycleState: "active",
  monitorId,
  packBinding,
  recordType: "public_source_subscription",
  schemaVersion: 1,
  sourceInstanceId: sourceInstance.sourceInstanceId,
  subscriptionId,
  workspaceId,
}), store);
const projected = await projectPublicSourceAcquisition({
  acquisition: acquisition.acquisition.result,
  projectedAt: new Date(observedAt),
  scope,
  subscriptionId,
}, { acquisition: store, subscription: store });
const filing = projected.projections.find(
  ({ fact }) => fact.factSchemaVersion === "house-ptr-filing/v1",
)!;
const transactions = projected.projections.filter(
  ({ fact }) => fact.factSchemaVersion === "house-ptr-transaction/v1",
);
assert.equal(transactions.length, 2);

const review = evaluateCongressionalFiling({
  catalogs: {
    committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
    committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
    member: CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1,
    security: CONGRESSIONAL_SECURITY_CATALOG_V1,
  },
  filing,
  minimumAlertBand: "review",
  observedAt,
  packBinding,
  policy: CONGRESSIONAL_POLICY_V1,
  processingMode: "live",
  selectedMemberBioguideIds: [],
  transactions,
});
assert.equal(review.transactions.length, 2);
assert.equal(review.signal.band, "review");
assert.equal(review.signal.alertEligible, true);
assert.equal(review.finding?.facts?.length, 1);
assert.equal(review.finding?.factIdentities.length, 1);
assert.match(review.finding?.summary ?? "", /not evidence of wrongdoing or a trade instruction/u);
assert.equal(JSON.stringify(review).includes("score"), false);
assert.equal(workspaceFindingCandidateSchema.safeParse(review.finding).success, true);

const firstCommit = await persistCongressionalFilingEvaluation({ evaluation: review, scope }, store);
assert.deepEqual(firstCommit, {
  signalCreated: true,
  signalReused: false,
  transactionsCreated: 2,
  transactionsReused: 0,
});
const replay = await persistCongressionalFilingEvaluation({ evaluation: review, scope }, store);
assert.deepEqual(replay, {
  signalCreated: false,
  signalReused: true,
  transactionsCreated: 0,
  transactionsReused: 2,
});
assert.deepEqual(
  await readCongressionalFilingSignal(scope, review.signal.signalRevisionId, store),
  review.signal,
);

const baseline = evaluateCongressionalFiling({
  catalogs: {
    committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
    committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
    member: CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1,
    security: CONGRESSIONAL_SECURITY_CATALOG_V1,
  },
  filing,
  minimumAlertBand: "review",
  observedAt,
  packBinding,
  policy: CONGRESSIONAL_POLICY_V1,
  processingMode: "baseline",
  selectedMemberBioguideIds: [],
  transactions,
});
assert.equal(baseline.signal.alertEligible, false);
assert.equal(baseline.signal.band, "record_only");
assert.equal(baseline.finding, null);
assert.ok(baseline.transactions.every((transaction) =>
  transaction.eligibility.reasonCodes.includes("baseline")));

const first = review.transactions.find(({ securityResolution }) =>
  securityResolution.state === "resolved")!;
const { transactionRevisionId: _revision, ...priorityCore } = first;
const materialCore = {
  ...priorityCore,
  amountRange: { label: "$50,001 - $100,000", lower: "50001", upper: "100000" },
  eligibility: { reasonCodes: ["eligible"] as const, state: "eligible" as const },
};
const material = houseStrategyTransactionSchema.parse({
  ...materialCore,
  transactionRevisionId: deriveHouseStrategyTransactionRevisionId(materialCore),
});
assert.equal(
  evaluateCongressionalTransaction(material, CONGRESSIONAL_POLICY_V1, {
    committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
    committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
  }).band,
  "priority",
);

function reviseTransaction(
  overrides: Partial<Omit<typeof first, "transactionRevisionId">>,
) {
  const { transactionRevisionId: _oldRevision, ...core } = first;
  const revisedCore = { ...core, ...overrides };
  return houseStrategyTransactionSchema.parse({
    ...revisedCore,
    transactionRevisionId: deriveHouseStrategyTransactionRevisionId(revisedCore),
  });
}
const stale = reviseTransaction({
  disclosureLagDays: 46,
  eligibility: { reasonCodes: ["stale_disclosure"], state: "record_only" },
});
assert.equal(evaluateCongressionalTransaction(stale, CONGRESSIONAL_POLICY_V1, {
  committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
}).band, "record_only");
assert.ok(evaluateCongressionalTransaction(stale, CONGRESSIONAL_POLICY_V1, {
  committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
}).reasonCodes.includes("stale_disclosure"));
const broadFund = reviseTransaction({
  eligibility: { reasonCodes: ["broad_fund"], state: "record_only" },
  securityResolution: { ...first.securityResolution, classification: "broad_fund" },
});
assert.equal(evaluateCongressionalTransaction(broadFund, CONGRESSIONAL_POLICY_V1, {
  committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
}).band, "record_only");
assert.ok(evaluateCongressionalTransaction(broadFund, CONGRESSIONAL_POLICY_V1, {
  committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
}).reasonCodes.includes("broad_fund"));
const unresolved = review.transactions.find(({ securityResolution }) =>
  securityResolution.state === "unknown")!;
assert.equal(evaluateCongressionalTransaction(unresolved, CONGRESSIONAL_POLICY_V1, {
  committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
}).band, "record_only");
assert.ok(unresolved.eligibility.reasonCodes.includes("unresolved_security"));

const unselected = evaluateCongressionalFiling({
  catalogs: {
    committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
    committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
    member: CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1,
    security: CONGRESSIONAL_SECURITY_CATALOG_V1,
  },
  filing,
  minimumAlertBand: "review",
  observedAt,
  packBinding,
  policy: CONGRESSIONAL_POLICY_V1,
  processingMode: "live",
  selectedMemberBioguideIds: ["T000488"],
  transactions,
});
assert.equal(unselected.signal.alertEligible, false);
assert.ok(unselected.transactions.every((transaction) =>
  transaction.eligibility.reasonCodes.includes("member_not_selected")));

const pack = strategyPackCatalog.resolve({ id: "congressional-signals", version: "1.0.0" });
assert.ok(pack);
assert.ok(pack.capabilities.hardDenied.includes("broker.mutation"));
assert.ok(pack.capabilities.hardDenied.includes("financial.mutation"));
assert.ok(STRATEGY_PACK_CAPABILITY_INVENTORY.some(
  ({ id }) => id === "evaluate_congressional_signals",
));
assert.equal(congressionalSignalsExecutionEnabled({}), false);
assert.equal(congressionalSignalsExecutionEnabled({ EVE_CONGRESSIONAL_SIGNALS_EXECUTION_ENABLED: "1" }), true);
assert.equal(congressionalSignalsExecutionEnabled({ EVE_CONGRESSIONAL_SIGNALS_EXECUTION_ENABLED: "true" }), false);

console.info("Congressional Signals Sprint 1 vertical verification passed.");
