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

const environment = {
  EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
};

const listed = listStrategyPacks({ environment });
assert.equal(listed.count, 24);
assert.deepEqual(
  listed.packs.map(({ id, version }) => `${id}@${version}`),
  [
    "congressional-signals@1.0.0",
    "congressional-signals@1.1.0",
    "congressional-signals@1.2.0",
    "congressional-signals@1.3.0",
    "earnings-call-changes@1.0.0",
    "earnings-call-changes@1.0.1",
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
    "ipo-filings@1.0.0",
    "ipo-filings@1.1.0",
    "ipo-filings@1.1.1",
    "ipo-filings@1.1.2",
    "public-commentary-tracker@1.0.0",
    "public-commentary-tracker@1.1.0",
  ],
);
assert.deepEqual(
  listLatestStrategyPacks({ environment }).packs.filter(({ id }) =>
    id === "inverse-cramer" || id === "public-commentary-tracker").map(({ id, version }) => `${id}@${version}`),
  ["inverse-cramer@1.4.7", "public-commentary-tracker@1.1.0"],
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

const [managerSource, statusToolSource] = await Promise.all([
  readFile(new URL("../agent/channels/photon-workspace-app.ts", import.meta.url), "utf8"),
  readFile(new URL("../agent/tools/get_workspace_status.ts", import.meta.url), "utf8"),
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

console.info("Strategy-pack owner surface verification passed.");
