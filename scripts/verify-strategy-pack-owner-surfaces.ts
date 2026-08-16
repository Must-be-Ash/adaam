import assert from "node:assert/strict";

import {
  inspectStrategyPack,
  listStrategyPacks,
  strategyPackCreateSelectionRequest,
} from "../agent/lib/strategy-pack-service";

const environment = {
  EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
};

const listed = listStrategyPacks({ environment });
assert.equal(listed.count, 1);
assert.deepEqual(
  listed.packs.map(({ id, version }) => `${id}@${version}`),
  ["ipo-filings@1.0.0"],
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

console.info("Strategy-pack owner surface verification passed.");
