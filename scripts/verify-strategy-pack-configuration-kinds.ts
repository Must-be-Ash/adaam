import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import {
  resolveStrategyPackConfiguration,
  strategyPackPinnedXIdentityFields,
  StrategyPackServiceError,
} from "../agent/lib/strategy-pack-service";
import { strategyPackConfigurationFieldSchema } from "../agent/lib/strategy-pack-schema";

const base = strategyPackCatalog.entries.find(({ id }) => id === "ipo-filings")!;
const fields = [
  {
    allowedValues: ["priority", "review"],
    default: "priority",
    description: "Lowest signal band that may create an alert.",
    key: "minimumAlertBand",
    kind: "bounded_enum",
    label: "Minimum alert band",
    mutableAfterInstall: true,
    pauseManagedMonitorsOnChange: true,
    required: true,
    rolloverGenerationOnChange: true,
  },
  {
    allowedValues: ["H001082", "T000488"],
    default: [],
    description: "Canonical House member IDs; empty means all members.",
    key: "selectedMemberBioguideIds",
    kind: "canonical_id_list",
    label: "Selected House members",
    maximumItems: 2,
    minimumItems: 0,
    mutableAfterInstall: true,
    pauseManagedMonitorsOnChange: true,
    required: true,
    rolloverGenerationOnChange: true,
  },
] as const;

for (const field of fields) assert.equal(strategyPackConfigurationFieldSchema.safeParse(field).success, true);
assert.equal(strategyPackConfigurationFieldSchema.safeParse({
  ...fields[0],
  default: "urgent",
}).success, false);
assert.equal(strategyPackConfigurationFieldSchema.safeParse({
  ...fields[1],
  allowedValues: ["T000488", "H001082"],
}).success, false);

const pack = { ...base, configuration: [...base.configuration, ...fields] };
const defaults = resolveStrategyPackConfiguration(pack, undefined);
assert.equal(defaults.configuration.minimumAlertBand, "priority");
assert.deepEqual(defaults.configuration.selectedMemberBioguideIds, []);
assert.deepEqual(defaults.ownerOverrides, {});

const configured = resolveStrategyPackConfiguration(pack, {
  minimumAlertBand: "review",
  selectedMemberBioguideIds: ["H001082"],
});
assert.deepEqual(configured.configuration.selectedMemberBioguideIds, ["H001082"]);
assert.equal(configured.configuration.minimumAlertBand, "review");
assert.deepEqual(configured.ownerOverrides.selectedMemberBioguideIds, ["H001082"]);

for (const invalid of [
  { minimumAlertBand: "urgent" },
  { selectedMemberBioguideIds: ["T000488", "H001082"] },
  { selectedMemberBioguideIds: ["Z999999"] },
  { selectedMemberBioguideIds: ["H001082", "T000488", "Z999999"] },
]) {
  assert.throws(
    () => resolveStrategyPackConfiguration(pack, invalid),
    (error) => error instanceof StrategyPackServiceError &&
      error.code === "strategy_pack_invalid_request",
  );
}

// Installing a pack that pins a public X identity requires an explicit,
// same-thread resolution receipt. The declared configuration kind selects that
// rule, so it is not tied to any pack identifier.
const pinnedIdentityPacks = strategyPackCatalog.entries
  .filter((entry) => strategyPackPinnedXIdentityFields(entry).length > 0)
  .map(({ id, version }) => `${id}@${version}`);
assert.deepEqual(pinnedIdentityPacks, [
  "public-commentary-tracker@1.0.0",
  "public-commentary-tracker@1.1.0",
  "public-commentary-tracker@1.2.0",
  "public-commentary-tracker@1.3.0",
  "public-commentary-tracker@1.3.1",
  "public-commentary-tracker@1.4.0",
  "public-commentary-tracker@1.5.0",
]);
const trackerPack = strategyPackCatalog.resolve({
  id: "public-commentary-tracker",
  version: "1.2.0",
});
assert.ok(trackerPack);
assert.deepEqual(
  strategyPackPinnedXIdentityFields(trackerPack).map(({ key }) => key),
  ["xIdentity"],
);
assert.deepEqual(
  strategyPackPinnedXIdentityFields({
    configuration: [{ ...fields[0], key: "notAnIdentity" }],
  } as unknown as Parameters<typeof strategyPackPinnedXIdentityFields>[0]),
  [],
);

// The manager route accepts the resolution receipt and must forward it to the
// create service. Dropping it silently fails every install of a pack that pins
// an identity, and the request-schema type alone does not catch that.
const managerRoute = readFileSync(
  new URL("../agent/channels/photon-workspace-app.ts", import.meta.url),
  "utf8",
);
assert.match(managerRoute, /xIdentityResolutionReceipt: body\.xIdentityResolutionReceipt/u);

// Installing fails closed when alert delivery cannot be set up. The owner must
// be told why, not handed an unexplained storage failure.
assert.match(
  managerRoute,
  /PhotonAlertDeliverySubscriptionError[\s\S]{0,400}could not set up alert delivery/u,
);

console.info("Strategy-pack bounded enum and canonical-ID list verification passed.");
