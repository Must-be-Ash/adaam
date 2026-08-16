import { createHash } from "node:crypto";

import {
  createPausedWorkspaceAcceptanceMonitor,
} from "../agent/lib/workspace-monitor-store";
import { runSecIpoReadOnlyLiveSmoke } from "../agent/lib/sec-ipo-live-smoke";
import {
  EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
  SEC_IPO_SOURCE_ID,
  SEC_IPO_SOURCE_URL,
} from "../agent/lib/sec-ipo-reference";
import { prepareSecIpoAcceptanceReplay } from "../agent/lib/strategy-pack-acceptance";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

if (process.argv.includes("--help")) {
  console.info([
    "Prepare a bounded, disposable SEC acceptance replay.",
    "",
    "Dry run (read-only):",
    "  npm run accept:strategy-packs:prepare -- --target-accession=<accession> --workspace-id=<uuid> --delivery-subscription-id=<id> --run-at=<ISO timestamp>",
    "",
    "Apply (owner-authorized Redis mutation; monitor remains paused):",
    "  add --apply --authorization=owner-approved and set EVE_STRATEGY_PACK_PRODUCTION_ACCEPTANCE_AUTHORIZED=1",
    "",
    "Requires SEC_USER_AGENT and the normal deployment owner/Redis configuration.",
  ].join("\n"));
} else {
  const targetAccessionNumber = option("target-accession") ?? "";
  const workspaceId = option("workspace-id") ?? "";
  const deliverySubscriptionId = option("delivery-subscription-id") ?? "";
  const runAt = option("run-at") ?? "";
  const apply = process.argv.includes("--apply");
  if (
    !/^\d{10}-\d{2}-\d{6}$/u.test(targetAccessionNumber) ||
    !/^[a-f0-9-]{36}$/u.test(workspaceId) ||
    deliverySubscriptionId.length < 3 ||
    deliverySubscriptionId.length > 160 ||
    !Number.isFinite(Date.parse(runAt))
  ) {
    throw new Error("acceptance_arguments_invalid");
  }
  if (Date.parse(runAt) <= Date.now()) {
    throw new Error("acceptance_run_time_not_future");
  }
  const ownerId = process.env.EVE_DEPLOYMENT_OWNER_ID ?? "";
  const scope = authorizeDeploymentWorkspaceStore(
    { ownerId, workspaceId },
    process.env,
  );
  const live = await runSecIpoReadOnlyLiveSmoke({
    userAgent: process.env.SEC_USER_AGENT,
  });
  const prepared = prepareSecIpoAcceptanceReplay({
    identityScope: scope,
    page: live.page,
    targetAccessionNumber,
  });
  const referencePack = strategyPackCatalog.resolve({
    id: "ipo-filings",
    version: "1.0.0",
  });
  if (!referencePack) throw new Error("acceptance_reference_pack_missing");
  const plan = {
    apply,
    catalogDigest: strategyPackCatalog.catalogDigest,
    checkpoint: prepared.checkpoint,
    packDigest: referencePack.contentDigest,
    runAt: new Date(runAt).toISOString(),
    sourceId: SEC_IPO_SOURCE_ID,
    targetAccessionNumber,
  };
  if (!apply) {
    console.info(JSON.stringify({ ...plan, status: "validated_read_only" }));
  } else {
    if (
      process.env.EVE_STRATEGY_PACK_PRODUCTION_ACCEPTANCE_AUTHORIZED !== "1" ||
      option("authorization") !== "owner-approved"
    ) {
      throw new Error("acceptance_owner_authorization_required");
    }
    const monitor = await createPausedWorkspaceAcceptanceMonitor({
      deliverySubscriptionId,
      idempotencyKey: `strategy-pack-acceptance:${createHash("sha256")
        .update(`${workspaceId}\0${targetAccessionNumber}\0${runAt}`)
        .digest("hex")}`,
      instruction:
        `Call ${EVALUATE_SEC_IPO_SOURCE_TOOL_ID} exactly once for the configured SEC source. Label any resulting alert as an owner-authorized acceptance replay.`,
      name: "IPO Filings acceptance replay",
      nextOccurrenceAt: new Date(runAt).toISOString(),
      requiredCapabilityIds: [EVALUATE_SEC_IPO_SOURCE_TOOL_ID],
      schedule: { at: new Date(runAt).toISOString(), kind: "one_time" },
      scope,
      sourceCheckpoint: prepared.checkpoint,
      sources: [{
        accessClassification: "public",
        canonicalUrl: SEC_IPO_SOURCE_URL,
        origin: "https://www.sec.gov",
        sourceId: SEC_IPO_SOURCE_ID,
      }],
    });
    console.info(JSON.stringify({
      ...plan,
      monitorId: monitor.monitorId,
      monitorState: monitor.lifecycleState,
      status: "paused_monitor_created",
    }));
  }
}
