import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  activatePhotonApproval,
  claimCurrentPhotonApprovalDecision,
  completePhotonApprovalDecision,
  getCurrentPhotonApprovalActivity,
  markPhotonApprovalExecution,
  releasePhotonApprovalProcessing,
  savePhotonApproval,
} from "../agent/lib/photon-approval-store.ts";

function verificationScope(label) {
  const nonce = randomUUID();
  return {
    principalId: `imessage:${label}-verification-${nonce}`,
    sessionId: `${label}-verification-${nonce}`,
    threadId: `imessage:${label}-verification-${nonce}`,
  };
}

async function createActiveApproval(
  scope,
  toolName = "coinbase_create_order",
) {
  const nonce = randomUUID();
  const saved = await savePhotonApproval({
    principalId: scope.principalId,
    prompt: {
      approvalText:
        toolName === "coinbase_create_order"
          ? "Buy 1 USD of BTC?"
          : "Delete event trigger?",
      expiresAtMs: Date.now() + 60_000,
      requestId: `request-${nonce}`,
      toolName,
    },
    sessionId: scope.sessionId,
    threadId: scope.threadId,
  });
  await activatePhotonApproval({
    approvalToken: saved.approvalToken,
    principalId: scope.principalId,
    threadId: scope.threadId,
  });
  return saved;
}

{
  const scope = verificationScope("guard");
  await createActiveApproval(scope);
  const claim = await claimCurrentPhotonApprovalDecision({
    decision: "approve",
    decisionSentAtMs: Date.now(),
    principalId: scope.principalId,
    threadId: scope.threadId,
  });
  assert.equal(claim.status, "deliver");
  assert.deepEqual(
    await claimCurrentPhotonApprovalDecision({
      decision: "approve",
      decisionSentAtMs: Date.now(),
      principalId: scope.principalId,
      threadId: scope.threadId,
    }),
    { decision: "approve", status: "processing" },
  );
  assert.equal(
    await getCurrentPhotonApprovalActivity(scope),
    "processing",
  );
  await completePhotonApprovalDecision({
    decision: "approve",
    recordKey: claim.delivery.recordKey,
  });
  assert.equal(
    await getCurrentPhotonApprovalActivity(scope),
    "processing",
  );
  assert.equal(
    await markPhotonApprovalExecution({
      sessionId: scope.sessionId,
      state: "succeeded",
    }),
    true,
  );
  assert.equal(
    await releasePhotonApprovalProcessing(scope.sessionId),
    "released",
  );
  assert.equal(await getCurrentPhotonApprovalActivity(scope), null);
}

{
  const scope = verificationScope("stale");
  await createActiveApproval(scope);
  const stale = await claimCurrentPhotonApprovalDecision({
    decision: "approve",
    decisionSentAtMs: Date.now() - 60_000,
    principalId: scope.principalId,
    threadId: scope.threadId,
  });
  assert.equal(stale.status, "stale");
  const denied = await claimCurrentPhotonApprovalDecision({
    decision: "deny",
    decisionSentAtMs: Date.now(),
    principalId: scope.principalId,
    threadId: scope.threadId,
  });
  assert.equal(denied.status, "deliver");
  await completePhotonApprovalDecision({
    decision: "deny",
    recordKey: denied.delivery.recordKey,
  });
  assert.equal(await getCurrentPhotonApprovalActivity(scope), null);
}

{
  const scope = verificationScope("race");
  await createActiveApproval(scope);
  const claim = await claimCurrentPhotonApprovalDecision({
    decision: "approve",
    decisionSentAtMs: Date.now(),
    principalId: scope.principalId,
    threadId: scope.threadId,
  });
  assert.equal(claim.status, "deliver");
  assert.equal(
    await markPhotonApprovalExecution({
      sessionId: scope.sessionId,
      state: "succeeded",
    }),
    true,
  );
  assert.equal(
    await releasePhotonApprovalProcessing(scope.sessionId),
    "released",
  );
  await completePhotonApprovalDecision({
    decision: "approve",
    recordKey: claim.delivery.recordKey,
  });
  assert.equal(await getCurrentPhotonApprovalActivity(scope), null);
}

{
  const scope = verificationScope("uncertain");
  await createActiveApproval(scope);
  const claim = await claimCurrentPhotonApprovalDecision({
    decision: "approve",
    decisionSentAtMs: Date.now(),
    principalId: scope.principalId,
    threadId: scope.threadId,
  });
  assert.equal(claim.status, "deliver");
  await completePhotonApprovalDecision({
    decision: "approve",
    recordKey: claim.delivery.recordKey,
  });
  assert.equal(
    await markPhotonApprovalExecution({
      sessionId: scope.sessionId,
      state: "uncertain",
    }),
    true,
  );
  assert.equal(
    await releasePhotonApprovalProcessing(scope.sessionId),
    "retained",
  );
  assert.equal(
    await getCurrentPhotonApprovalActivity(scope),
    "processing",
  );
}

{
  const scope = verificationScope("non-financial");
  await createActiveApproval(scope, "delete_event_trigger");
  const claim = await claimCurrentPhotonApprovalDecision({
    decision: "approve",
    decisionSentAtMs: Date.now(),
    principalId: scope.principalId,
    threadId: scope.threadId,
  });
  assert.equal(claim.status, "deliver");
  await completePhotonApprovalDecision({
    decision: "approve",
    recordKey: claim.delivery.recordKey,
  });
  assert.equal(await getCurrentPhotonApprovalActivity(scope), null);
  assert.equal(
    await releasePhotonApprovalProcessing(scope.sessionId),
    "missing",
  );
}

{
  const scope = verificationScope("preactivation");
  const nonce = randomUUID();
  const saved = await savePhotonApproval({
    principalId: scope.principalId,
    prompt: {
      approvalText: "Buy 1 USD of BTC?",
      expiresAtMs: Date.now() + 60_000,
      requestId: `request-${nonce}`,
      toolName: "coinbase_create_order",
    },
    sessionId: scope.sessionId,
    threadId: scope.threadId,
  });
  const sentBeforeActivationAtMs = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await activatePhotonApproval({
    approvalToken: saved.approvalToken,
    principalId: scope.principalId,
    threadId: scope.threadId,
  });
  assert.deepEqual(
    await claimCurrentPhotonApprovalDecision({
      decision: "approve",
      decisionSentAtMs: sentBeforeActivationAtMs,
      principalId: scope.principalId,
      threadId: scope.threadId,
    }),
    { status: "stale" },
  );
  const denied = await claimCurrentPhotonApprovalDecision({
    decision: "deny",
    decisionSentAtMs: Date.now(),
    principalId: scope.principalId,
    threadId: scope.threadId,
  });
  assert.equal(denied.status, "deliver");
  await completePhotonApprovalDecision({
    decision: "deny",
    recordKey: denied.delivery.recordKey,
  });
}

console.log("Photon Redis approval lifecycle verification passed.");
