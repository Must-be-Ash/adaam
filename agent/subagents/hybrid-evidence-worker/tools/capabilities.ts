import type { SessionContext } from "eve/context";
import { defineDynamic, defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

import {
  requireHybridEvidenceWorkerAuth,
  verifyHybridEvidenceWorkerToken,
} from "../../../lib/hybrid-evidence-auth";
import { createHybridEvidenceWorkerArtifactStore } from "../../../lib/hybrid-evidence-artifact-store";
import { evidenceLocatorSchema } from "../../../lib/hybrid-evidence-schema";
import {
  completeHybridEvidenceJobForWorker,
  readHybridEvidenceSliceForWorker,
  workerCandidateSchema,
} from "../../../lib/hybrid-evidence-worker";
import { resolveHybridEvidenceWorkerFixtureClients } from "../../../lib/hybrid-evidence-worker-test-fixtures";

const readHybridEvidenceSlice = defineTool({
  description: "Read one bounded public evidence slice authorized by this signed single-job scope.",
  inputSchema: z.object({ locator: evidenceLocatorSchema }).strict(),
  async execute({ locator }, ctx) {
    const fixture = resolveHybridEvidenceWorkerFixtureClients();
    const artifacts = fixture?.artifacts ?? createHybridEvidenceWorkerArtifactStore();
    return readHybridEvidenceSliceForWorker({
      clients: { artifacts, jobs: fixture?.jobs, readSourceFact: fixture?.readSourceFact },
      ctx,
      locator,
    });
  },
  toModelOutput(output) {
    return output.contentKind === "image"
      ? toolOutput.content([
          toolOutputPart.text(`Bounded public PDF evidence for locator ${output.locatorDigest}:`),
          toolOutputPart.file(output.content, { mediaType: "image/png" }),
        ])
      : toolOutput.text(output.content);
  },
});

const completeHybridEvidenceJob = defineTool({
  description: "Commit the one bounded structured candidate for this signed hybrid-evidence job.",
  inputSchema: workerCandidateSchema,
  async execute(candidate, ctx) {
    return completeHybridEvidenceJobForWorker({
      candidate,
      ctx,
      jobClient: resolveHybridEvidenceWorkerFixtureClients()?.jobs,
    });
  },
});

const fixtureReadHybridEvidenceSlice = defineTool({
  description: "Fixture-only compiled boundary for the signed evidence read.",
  inputSchema: z.object({ city: z.string().optional() }).strict(),
  async execute(_input, ctx) {
    const fixture = resolveHybridEvidenceWorkerFixtureClients();
    if (!fixture) throw new Error("hybrid_worker_fixture_clients_missing");
    const { envelope } = requireHybridEvidenceWorkerAuth(ctx);
    const locator = envelope.allowedLocators[0];
    if (!locator) throw new Error("hybrid_worker_fixture_locator_missing");
    const output = await readHybridEvidenceSliceForWorker({ clients: fixture, ctx, locator });
    return Object.freeze({ ...output, stepKey: "complete" });
  },
});

const fixtureCompleteHybridEvidenceJob = defineTool({
  description: "Fixture-only compiled boundary for the signed evidence commit.",
  inputSchema: z.object({ stepKey: z.string() }).strict(),
  async execute(_input, ctx) {
    const fixture = resolveHybridEvidenceWorkerFixtureClients();
    if (!fixture) throw new Error("hybrid_worker_fixture_clients_missing");
    const { envelope } = requireHybridEvidenceWorkerAuth(ctx);
    return completeHybridEvidenceJobForWorker({
      candidate: {
        citations: envelope.allowedLocators,
        disposition: "accepted",
        fields: {},
        unknowns: [],
      },
      ctx,
      jobClient: fixture.jobs,
    });
  },
});

function resolve(ctx: {
  readonly session: { readonly auth: SessionContext["session"]["auth"] };
}) {
  const token = ctx.session.auth.current?.attributes.hybrid_evidence_runtime_token;
  if (typeof token !== "string") return null;
  try {
    verifyHybridEvidenceWorkerToken(token);
    if (
      process.env.NODE_ENV === "test" &&
      process.env.VERCEL === undefined &&
      process.env.VERCEL_ENV === undefined &&
      process.env.EVE_HYBRID_EVIDENCE_WORKER_FIXTURE_RPC_URL
    ) {
      return {
        read_hybrid_evidence_slice: fixtureReadHybridEvidenceSlice,
        complete_hybrid_evidence_job: fixtureCompleteHybridEvidenceJob,
      };
    }
    return {
      read_hybrid_evidence_slice: readHybridEvidenceSlice,
      complete_hybrid_evidence_job: completeHybridEvidenceJob,
    };
  } catch {
    return null;
  }
}

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) => resolve(ctx),
    "turn.started": (_event, ctx) => resolve(ctx),
  },
});
