import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  inspectStrategyPack,
  listLatestStrategyPacks,
  listStrategyPacks,
  strategyPackConfigureSelectionRequest,
  strategyPackCreateSelectionRequest,
  strategyPackRemoveSelectionRequest,
} from "../agent/lib/strategy-pack-service";
import { strategyPackCompatibilityInstruction } from "../agent/instructions/strategy-pack";
import { photonAuth } from "../agent/lib/photon-auth";
import { projectPhotonWorkspaceRuntimeScope } from "../agent/lib/workspace-runtime-scope";
import { executeCongressionalHistoryQuery } from "../agent/tools/query_congressional_history";

const environment = {
  EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture-owner",
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
};

const listed = listStrategyPacks({ environment });
assert.equal(listed.count, 39);
assert.deepEqual(
  listed.packs.map(({ id, version }) => `${id}@${version}`),
  [
    "congressional-signals@1.0.0",
    "congressional-signals@1.1.0",
    "congressional-signals@1.2.0",
    "congressional-signals@1.3.0",
    "congressional-signals@1.4.0",
    "congressional-signals@1.5.0",
    "congressional-signals@1.6.0",
    "earnings-call-changes@1.0.0",
    "earnings-call-changes@1.0.1",
    "earnings-call-changes@1.1.0",
    "earnings-call-changes@1.2.0",
    "inverse-cramer@1.0.0",
    "inverse-cramer@1.1.0",
    "inverse-cramer@1.2.0",
    "inverse-cramer@1.3.0",
    "inverse-cramer@1.4.0",
    "inverse-cramer@1.4.1",
    "inverse-cramer@1.4.2",
    "inverse-cramer@1.4.3",
    "inverse-cramer@1.4.4",
    "inverse-cramer@1.4.5",
    "inverse-cramer@1.4.6",
    "inverse-cramer@1.4.7",
    "inverse-cramer@1.4.8",
    "inverse-cramer@1.4.9",
    "inverse-cramer@1.5.0",
    "ipo-filings@1.0.0",
    "ipo-filings@1.1.0",
    "ipo-filings@1.1.1",
    "ipo-filings@1.1.2",
    "public-commentary-tracker@1.0.0",
    "public-commentary-tracker@1.1.0",
    "public-commentary-tracker@1.2.0",
    "public-commentary-tracker@1.3.0",
    "public-commentary-tracker@1.3.1",
    "public-commentary-tracker@1.4.0",
    "public-commentary-tracker@1.5.0",
    "public-commentary-tracker@1.5.1",
    "public-commentary-tracker@1.5.2",
  ],
);
assert.deepEqual(
  listLatestStrategyPacks({ environment }).packs.filter(({ id }) =>
    id === "inverse-cramer" || id === "public-commentary-tracker").map(({ id, version }) => `${id}@${version}`),
  ["inverse-cramer@1.5.0", "public-commentary-tracker@1.5.2"],
);
assert.equal(JSON.stringify(listed).includes("Detect only newly"), false);

const inspected = inspectStrategyPack(
  { id: "ipo-filings", version: "1.0.0" },
  { environment },
);
assert.equal(inspected.pack.id, "ipo-filings");
assert.equal(inspected.pack.monitors[0]?.resourceId, "detect-new-s1");
assert.equal(inspected.pack.sources[0]?.sourceId, "sec-latest-s1-filings");
assert.equal(inspected.pack.instructionsIncluded, false);

const trackerInspection = inspectStrategyPack(
  { id: "public-commentary-tracker", version: "1.5.2" },
  { environment },
);
assert.equal(trackerInspection.pack.configurationPresets?.defaultId, "kobeissi-market");
assert.deepEqual(
  trackerInspection.pack.configurationPresets?.options.map(({ id, label }) => ({ id, label })),
  [
    { id: "kobeissi-market", label: "Kobeissi market tracker" },
    { id: "trump-iran-oil", label: "Trump–Iran oil tracker" },
  ],
);

const eveRequest = strategyPackCreateSelectionRequest({
  activateMonitorResourceIds: ["detect-new-s1"],
  configuration: {
    dailyTimes: ["09:00", "16:00"],
    timezone: "America/Vancouver",
  },
  expectedRegistryRevision: 7,
  name: "IPO Filings",
  packId: "ipo-filings",
  packVersion: "1.0.0",
}, { environment });
const spectrumRequest = strategyPackCreateSelectionRequest({
  activateMonitorResourceIds: ["detect-new-s1"],
  configuration: {
    dailyTimes: ["09:00", "16:00"],
    timezone: "America/Vancouver",
  },
  expectedRegistryRevision: 7,
  name: "IPO Filings",
  packId: "ipo-filings",
  packVersion: "1.0.0",
}, { environment });
assert.deepEqual(eveRequest, spectrumRequest);
assert.equal(eveRequest.pack.contentDigest, inspected.pack.contentDigest);

const configureInput = {
  confirmedConsequences: true as const,
  configuration: { dailyTimes: ["08:30"], timezone: "America/Vancouver" },
  expectedBindingRevision: 3,
  expectedRegistryRevision: 7,
};
assert.deepEqual(
  strategyPackConfigureSelectionRequest(configureInput),
  strategyPackConfigureSelectionRequest(configureInput),
);
const removeInput = {
  confirmedConsequences: true as const,
  expectedBindingRevision: 4,
  expectedRegistryRevision: 8,
};
assert.deepEqual(
  strategyPackRemoveSelectionRequest(removeInput),
  strategyPackRemoveSelectionRequest(removeInput),
);

assert.throws(
  () => listStrategyPacks({ environment: {} }),
  /strategy_pack_catalog_disabled/u,
);
assert.throws(
  () => inspectStrategyPack(
    { id: "ipo-filings", version: "9.9.9" },
    { environment },
  ),
  /strategy_pack_unavailable/u,
);

const [managerSource, statusToolSource, congressionalHistoryToolSource] = await Promise.all([
  readFile(new URL("../agent/channels/photon-workspace-app.ts", import.meta.url), "utf8"),
  readFile(new URL("../agent/tools/get_workspace_status.ts", import.meta.url), "utf8"),
  readFile(new URL("../agent/tools/query_congressional_history.ts", import.meta.url), "utf8"),
]);
for (const source of [managerSource, statusToolSource]) {
  assert.match(source, /readEarningsCallWorkspacePresentation/u,
    "manager and read-only agent status must consume the shared issuer projection");
}
assert.match(
  statusToolSource,
  /const earningsCallChangesActive[\s\S]*earningsCallChangesActive && earningsMonitor/u,
  "status reads must gate earnings source health on the active earnings strategy pack",
);
assert.match(managerSource, /resolutionEpoch \+= 1/u, "editing a profile invalidates any in-flight identity resolution");
assert.match(managerSource, /requestEpoch !== resolutionEpoch \|\| profile\.value !== requestedProfile/u);
assert.match(managerSource, /resolutionReceipt/u, "the confirmed identity carries a signed, scoped receipt into creation");
assert.match(congressionalHistoryToolSource,
  /executeCongressionalHistoryQuery\(input, ctx\)/u,
  "the member-history tool must apply the member selector inside the authenticated workspace read");
const runtimeScope = projectPhotonWorkspaceRuntimeScope({
  generation: 1,
  principalId: "imessage:fixture-owner",
  threadId: "imessage:fixture-thread",
  workspaceId: "123e4567-e89b-42d3-a456-426614175599",
}, environment);
const toolContext = { session: { auth: { current: photonAuth("fixture-owner", "imessage:fixture-thread", runtimeScope) } } };
let requestedMember: string | null = null;
const queried = await executeCongressionalHistoryQuery({ member: "Nancy Pelosi" }, toolContext, {
  environment,
  inspect: async () => ({ pack: { id: "congressional-signals" }, state: "active" }) as never,
  read: async ({ member }) => { requestedMember = member; return { member } as never; },
});
assert.equal(requestedMember, "Nancy Pelosi");
assert.deepEqual(queried, { member: "Nancy Pelosi" });
for (const binding of [
  { state: "unbound" },
  { pack: { id: "ipo-filings" }, state: "active" },
]) {
  await assert.rejects(() => executeCongressionalHistoryQuery({ member: "Nancy Pelosi" }, toolContext, {
    environment,
    inspect: async () => binding as never,
    read: async () => { throw new Error("history read must not run"); },
  }), /congressional_signal_workspace_unavailable/u);
}
assert.match(strategyPackCompatibilityInstruction({ id: "congressional-signals", version: "1.6.0" }) ?? "",
  /Never answer a member-specific history question from the latest signal/u);
assert.match(strategyPackCompatibilityInstruction({ id: "congressional-signals", version: "1.5.0" }) ?? "",
  /cannot suppress the factual disclosure notification/u,
  "the prior compatibility amendment must retain mandatory transaction-first delivery");
assert.equal(strategyPackCompatibilityInstruction({ id: "ipo-filings", version: "1.1.2" }), null);

console.info("Strategy-pack owner surface verification passed.");
