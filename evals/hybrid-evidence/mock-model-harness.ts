import { mockModel } from "eve/evals";
import { z } from "zod";

import type { HybridEvidenceFlags } from "../../agent/lib/hybrid-evidence-flags";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const fixtureEvidenceSchema = z.discriminatedUnion("shape", [
  z.object({
    byteCount: z.number().int().positive().max(10 * 1_024 * 1_024),
    imageOnly: z.boolean(),
    pageCount: z.number().int().positive().max(8),
    shape: z.literal("pdf"),
    slices: z.array(z.string().max(2_000)).max(8),
  }).strict(),
  z.object({
    rows: z.array(z.array(z.string().max(200)).max(16)).max(32),
    shape: z.literal("spreadsheet"),
    sheet: z.string().min(1).max(80),
  }).strict(),
  z.object({
    shape: z.literal("semantic_text"),
    text: z.string().min(1).max(8_000),
  }).strict(),
]);

const expectedOutcomeSchema = z.object({
  canonicalFactCreated: z.boolean(),
  errorCode: z.string().min(3).max(80).nullable(),
  modelRequired: z.boolean(),
  outcome: z.enum(["accepted", "abstained", "deterministic_bypass", "quarantined"]),
  sourceCursorAdvances: z.boolean(),
}).strict();

export const hybridEvidenceFixtureCaseSchema = z.object({
  deterministicParser: z.object({
    errorCode: z.string().min(3).max(80).nullable(),
    state: z.enum(["complete", "partial", "suspicious", "unsupported"]),
  }).strict(),
  evidence: fixtureEvidenceSchema,
  expected: expectedOutcomeSchema,
  fixtureId: z.string().min(3).max(160).regex(/^[a-z0-9][a-z0-9._-]+$/u),
  inputDigest: digestSchema,
  lane: z.enum(["source_global_extraction", "workspace_semantic"]),
  mockCandidate: z.object({
    citations: z.array(z.string().min(1).max(160)).max(16),
    disposition: z.enum(["accepted", "abstained", "quarantined"]),
    fields: z.record(z.string(), z.unknown()),
    unknowns: z.array(z.string().min(1).max(160)).max(16),
  }).strict(),
  tags: z.array(z.enum([
    "accepted",
    "abstained",
    "ambiguous",
    "false_success_layout",
    "hostile_document",
    "prompt_injection",
    "quarantined",
  ])).min(1).max(6),
}).strict().superRefine((fixture, context) => {
  const expectedLane = fixture.evidence.shape === "semantic_text"
    ? "workspace_semantic"
    : "source_global_extraction";
  if (fixture.lane !== expectedLane) {
    context.addIssue({ code: "custom", message: "fixture_lane_invalid" });
  }
  if ((fixture.deterministicParser.state === "complete") !==
      (fixture.deterministicParser.errorCode === null)) {
    context.addIssue({ code: "custom", message: "fixture_parser_outcome_invalid" });
  }
});

export const hybridEvidenceFixtureCorpusSchema = z.object({
  cases: z.array(hybridEvidenceFixtureCaseSchema).min(12).max(64),
  corpusId: z.literal("hybrid-evidence-core"),
  corpusVersion: z.literal("1.0.0"),
  schemaVersion: z.literal(1),
}).strict().superRefine((corpus, context) => {
  if (new Set(corpus.cases.map(({ fixtureId }) => fixtureId)).size !== corpus.cases.length) {
    context.addIssue({ code: "custom", message: "fixture_id_duplicate" });
  }
});

export type HybridEvidenceFixtureCase = z.infer<typeof hybridEvidenceFixtureCaseSchema>;
export type HybridEvidenceFixtureCorpus = z.infer<typeof hybridEvidenceFixtureCorpusSchema>;

export class HybridEvidenceMissingProductionSeamError extends Error {
  constructor(readonly code:
    | "artifact_store_unimplemented"
    | "job_store_unimplemented"
    | "worker_runtime_unimplemented") {
    super(code);
    this.name = "HybridEvidenceMissingProductionSeamError";
  }
}

export interface HybridEvidenceContractHarnessSeams {
  readonly persistArtifact?: (fixture: HybridEvidenceFixtureCase) => Promise<void>;
  readonly prepareJob?: (fixture: HybridEvidenceFixtureCase) => Promise<void>;
  readonly runWorker?: (fixture: HybridEvidenceFixtureCase) => Promise<void>;
}

export function createHybridEvidenceMockModelHarness(
  corpus: HybridEvidenceFixtureCorpus,
) {
  const cases = new Map(corpus.cases.map((fixture) => [fixture.fixtureId, fixture]));
  const calls: string[] = [];
  const model = mockModel({
    modelId: "hybrid-evidence-contract-fixture",
    provider: "adaam-fixtures",
    respond: ({ lastUserMessage }) => {
      const request = z.object({ fixtureId: z.string() }).strict().parse(
        JSON.parse(lastUserMessage ?? "null"),
      );
      const fixture = cases.get(request.fixtureId);
      if (!fixture) throw new Error("hybrid_fixture_not_found");
      calls.push(fixture.fixtureId);
      return JSON.stringify(fixture.mockCandidate);
    },
  });
  return Object.freeze({ calls, model });
}

export async function runHybridEvidenceContractHarness(input: {
  readonly fixture: HybridEvidenceFixtureCase;
  readonly flags: HybridEvidenceFlags;
  readonly seams?: HybridEvidenceContractHarnessSeams;
}): Promise<"deterministic_bypass" | "hybrid_disabled"> {
  if (input.fixture.deterministicParser.state === "complete") {
    return "deterministic_bypass";
  }
  const laneEnabled = input.fixture.lane === "source_global_extraction"
    ? input.flags.extractionRecovery
    : input.flags.semanticReasoning;
  if (!laneEnabled) return "hybrid_disabled";

  if (!input.seams?.persistArtifact) {
    throw new HybridEvidenceMissingProductionSeamError("artifact_store_unimplemented");
  }
  await input.seams.persistArtifact(input.fixture);
  if (!input.seams.prepareJob) {
    throw new HybridEvidenceMissingProductionSeamError("job_store_unimplemented");
  }
  await input.seams.prepareJob(input.fixture);
  if (!input.seams.runWorker) {
    throw new HybridEvidenceMissingProductionSeamError("worker_runtime_unimplemented");
  }
  await input.seams.runWorker(input.fixture);
  throw new HybridEvidenceMissingProductionSeamError("worker_runtime_unimplemented");
}
