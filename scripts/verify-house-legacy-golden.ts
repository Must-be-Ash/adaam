import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { createHybridEvidenceArtifactStore } from "../agent/lib/hybrid-evidence-artifact-store";
import { bindHouseModelCandidateCitations, createHouseHybridEvidenceRecovery, HOUSE_HYBRID_EVIDENCE_RECOVERY_REGISTRATION, independentPdfOcrModelSettings } from "../agent/lib/house-hybrid-evidence-recovery";
import { houseDocumentRowModelCandidateSchema, houseDocumentRowWorkerCandidateSchema, validateHouseDocumentRowCandidate, type HouseDocumentRowWorkerCandidate } from "../agent/lib/hybrid-evidence-extraction-recovery";
import { projectHybridEvidencePdf } from "../agent/lib/hybrid-evidence-pdf";
import { runHousePublicSourceAcquisition } from "../agent/lib/house-public-source-adapter";
import { readGlobalDispatchBudgetLedger } from "../agent/lib/workspace-dispatch-budget";
import { readWorkspaceBudgetLedger, reserveWorkspaceRunBudget } from "../agent/lib/workspace-budget-ledger";
import { HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID } from "../agent/lib/strategy-pack-reference-catalog";
import { publicSourceSubscriptionSchema } from "../agent/lib/public-source-adapter-schema";
import { derivePublicSourceSubscriptionId, ensurePublicSourceSubscription, projectPublicSourceAcquisition } from "../agent/lib/public-source-subscription-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { writeWorkspaceDocument } from "../agent/lib/workspace-state-store";
import { evaluateCongressionalFiling } from "../agent/lib/congressional-strategy";
import { CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1, CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
  CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1, CONGRESSIONAL_POLICY_V1, CONGRESSIONAL_SECURITY_CATALOG_V1 } from "../agent/lib/congressional-reference-catalog";

const root = new URL("./fixtures/public-source-adapters/house/live-review-2026-08-30/", import.meta.url);
assert.deepEqual(independentPdfOcrModelSettings("google/gemini-3-flash"), {
  providerOptions: { google: { thinkingConfig: { thinkingLevel: "minimal" } } },
});
assert.deepEqual(independentPdfOcrModelSettings("google/gemini-3-pro"), { reasoning: "minimal" });
assert.deepEqual(independentPdfOcrModelSettings("fixture/ocr"), { reasoning: "minimal" });
function readFlagValue(name: string): string | null {
  const value = process.argv.find((argument) => argument.startsWith(`${name}=`));
  return value ? value.slice(name.length + 1) : null;
}

const captureOutput = readFlagValue("--capture-output");
const replayOutput = readFlagValue("--replay-output");
const live = process.argv.includes("--live-max-usd=1");
if (process.argv.some((arg) => arg.startsWith("--live")) && !live) {
  throw new Error("Explicit --live-max-usd=1 is required for the single paid canary");
}
if (captureOutput && replayOutput) {
  throw new Error("Choose either --capture-output or --replay-output");
}
if (captureOutput && !live) {
  throw new Error("--capture-output requires the explicit --live-max-usd=1 canary opt-in");
}
if (replayOutput && live) {
  throw new Error("--replay-output is offline-only and cannot be combined with --live-max-usd=1");
}
const golden = JSON.parse(await readFile(new URL("ptr-8221359.golden.json", root), "utf8")) as {
  sha256: string;
  document: { docId: string; filerName: string; filingDate: string; stateDistrict: string; isAmendment: boolean };
  pages: [string, string, "P" | "S", string][][];
};
const pdf = new Uint8Array(await readFile(new URL("ptr-8221359.pdf", root)));
assert.equal(createHash("sha256").update(pdf).digest("hex"), golden.sha256);
assert.deepEqual(golden.pages.map((rows) => rows.length), [25, 26, 26, 26, 20]);
const labels: Record<string, string> = {
  A: "$1,001 - $15,000", B: "$15,001 - $50,000", C: "$50,001 - $100,000",
  D: "$100,001 - $250,000", E: "$250,001 - $500,000", F: "$500,001 - $1,000,000",
  K: "Spouse/DC Asset Over $1,000,000",
};
const rows = golden.pages.flatMap((page, index) => page.map(([assetDescription, day, transactionType, band]) => ({
  assetDescription, transactionType, amountRange: labels[band]!, page: index + 1,
  transactionDate: `2026-02-${day}`, notificationDate: "2026-03-05", ownerCode: "SP",
  reportedTicker: null, capitalGainsIndicator: "unknown" as const,
})));
const projection = await projectHybridEvidencePdf(pdf, { maximumRenderEdge: 2400 });
const citations = projection.pages.map((page) => ({
  artifactDigest: golden.sha256, evidenceDigest: page.evidenceDigest,
  kind: "pdf_page" as const, page: page.page, region: null,
}));
const candidate = { citations, disposition: "accepted" as const, fields: { document: golden.document, rows }, unknowns: [] };
type PublicRecoveryOutput = Readonly<{
  candidate: HouseDocumentRowWorkerCandidate;
  extractionUsage: { inputTokens: number; outputTokens: number; paidCostUsd?: string };
  independentEvidence: Readonly<{
    pageUsage: readonly [number, { inputTokens: number; outputTokens: number; paidCostUsd?: string }][];
    textByPage: readonly [number, string][];
    usage: { inputTokens: number; outputTokens: number; paidCostUsd?: string };
  }>;
  schemaVersion: 1;
}>;

function parsePublicRecoveryOutput(value: unknown): PublicRecoveryOutput {
  if (!value || typeof value !== "object") throw new Error("public_recovery_output_invalid");
  const output = value as Record<string, unknown>;
  if (output.schemaVersion !== 1) throw new Error("public_recovery_output_version_invalid");
  const parseUsage = (usage: unknown) => {
    if (!usage || typeof usage !== "object") throw new Error("public_recovery_output_usage_invalid");
    const candidateUsage = usage as Record<string, unknown>;
    if (!Number.isInteger(candidateUsage.inputTokens) || !Number.isInteger(candidateUsage.outputTokens) ||
      (candidateUsage.paidCostUsd !== undefined &&
        (typeof candidateUsage.paidCostUsd !== "string" || !/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/u.test(candidateUsage.paidCostUsd)))) {
      throw new Error("public_recovery_output_usage_invalid");
    }
    return {
      inputTokens: candidateUsage.inputTokens as number,
      outputTokens: candidateUsage.outputTokens as number,
      ...(candidateUsage.paidCostUsd === undefined ? {} : { paidCostUsd: candidateUsage.paidCostUsd as string }),
    };
  };
  if (!output.independentEvidence || typeof output.independentEvidence !== "object") {
    throw new Error("public_recovery_output_ocr_invalid");
  }
  const independent = output.independentEvidence as Record<string, unknown>;
  if (!Array.isArray(independent.textByPage) || !independent.textByPage.every((entry) =>
    Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) &&
      typeof entry[1] === "string" && entry[0] >= 1 && entry[0] <= 8)) {
    throw new Error("public_recovery_output_ocr_invalid");
  }
  if (!Array.isArray(independent.pageUsage) || !independent.pageUsage.every((entry) =>
    Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) &&
      entry[0] >= 1 && entry[0] <= 8)) {
    throw new Error("public_recovery_output_ocr_usage_invalid");
  }
  return {
    candidate: houseDocumentRowWorkerCandidateSchema.parse(output.candidate),
    extractionUsage: parseUsage(output.extractionUsage),
    independentEvidence: {
      pageUsage: independent.pageUsage.map(([page, usage]) => [page, parseUsage(usage)] as const),
      textByPage: independent.textByPage as [number, string][],
      usage: parseUsage(independent.usage),
    },
    schemaVersion: 1,
  };
}
const recordedOutput = replayOutput
  ? parsePublicRecoveryOutput(JSON.parse(await readFile(replayOutput, "utf8")))
  : null;
function replayOcrUsage(output: PublicRecoveryOutput, page: number) {
  // The completed OCR record owns one aggregate receipt; per-page receipts may
  // have been compacted. Charge it once in replay, never substitute fixture fees.
  return page === Math.min(...output.independentEvidence.textByPage.map(([number]) => number))
    ? output.independentEvidence.usage
    : { inputTokens: 0, outputTokens: 0, paidCostUsd: "0" };
}
function capturedPaidMicros(output: PublicRecoveryOutput): bigint {
  const prices = [output.extractionUsage.paidCostUsd, output.independentEvidence.usage.paidCostUsd];
  if (prices.some((price) => price === undefined)) return 1_000_000n;
  return prices.reduce((total, price) => {
    const [whole, fraction = ""] = price!.split(".");
    return total + BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  }, 0n);
}
const modelCandidate = { ...candidate, citations: citations.map(({ page }) => ({ page })) };
assert.equal(houseDocumentRowModelCandidateSchema.safeParse(modelCandidate).success, true);
assert.equal(houseDocumentRowModelCandidateSchema.safeParse({
  ...modelCandidate,
  citations: [{}],
}).success, false, "the direct model must provide a page");
assert.equal(houseDocumentRowModelCandidateSchema.safeParse({
  ...modelCandidate,
  citations: [{ page: 1, evidenceDigest: "a".repeat(64) }],
}).success, false, "the direct model must not echo trusted locator hashes");
assert.deepEqual(bindHouseModelCandidateCitations({ candidate: modelCandidate, locators: citations }), candidate);
assert.throws(() => bindHouseModelCandidateCitations({
  candidate: { ...modelCandidate, citations: [{ page: 8 }] },
  locators: citations,
}), /citation_invalid/u, "an unknown page cannot be rebound into trusted evidence");
const textByPage = new Map(golden.pages.map((_, index) => [index + 1,
  "documentType=Periodic Transaction Report; filerName=MICHAEL MCCAUL; filingDate=3/10/2026; reportStatus=legacy_grid_no_status;\n" +
  rows.filter((row) => row.page === index + 1).map((row) => [row.ownerCode, row.assetDescription,
    row.transactionType, row.transactionDate, row.notificationDate, row.amountRange].join(" ")).join("\n"),
]));
const replayTextByPage = recordedOutput ? new Map(recordedOutput.independentEvidence.textByPage) : textByPage;
const validate = (value: unknown) => validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256, candidate: value, expected: golden.document, independentTextByPage: textByPage, projection,
});
const validated = validate(candidate);
assert.equal(validated.rows.length, 123);
assert.throws(() => validate({
  ...candidate,
  citations: candidate.citations.map((citation, index) => index === 0
    ? { ...citation, evidenceDigest: "b".repeat(64) }
    : citation),
}), /citation_invalid/u, "a tampered trusted page locator is rejected deterministically");
function comparableGoldenRows<T extends { assetDescription: string; rowEvidenceDigest: string }>(
  values: readonly T[],
) {
  return values.map(({ assetDescription, rowEvidenceDigest: _digest, ...row }) => ({
    ...row,
    // House's all-caps grid is visual typography. Preserve every non-text
    // field and duplicate/order exactly while accepting cosmetic OCR casing.
    assetDescription: assetDescription.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US"),
  }));
}
const expectedGoldenRows = comparableGoldenRows(validated.rows);
assert.equal(new Set(validated.rows.map((row) => row.rowEvidenceDigest)).size, 123);
assert.deepEqual(validated.rows.filter((row) => row.amountRange.upper === null).map((row) => row.amountRange), [
  { label: labels.K, lower: "1000001", upper: null }, { label: labels.K, lower: "1000001", upper: null },
]);
for (const droppedIndex of [0, 15, 122]) {
  assert.throws(() => validate({ ...candidate, fields: { ...candidate.fields, rows: rows.filter((_, index) => index !== droppedIndex) } }),
    /source_relationship_invalid|row_identity_ambiguous/u, "an individually supported subset must not become complete");
}
assert.throws(() => validate({ ...candidate, fields: { ...candidate.fields, rows: [...rows, rows.at(-1)!] } }),
  /source_relationship_invalid|row_identity_ambiguous/u);
assert.equal(validate({
  ...candidate,
  fields: { ...candidate.fields, rows },
}).rows.length, 123, "the canonical OCR form remains accepted");
assert.deepEqual(validate({
  ...candidate,
  fields: { ...candidate.fields, rows },
}), validated, "validation is deterministic");
const pipeDelimitedEvidence = new Map([...textByPage].map(([page, text]) => [
  page,
  text.replace(/\s+/gu, " | "),
]));
assert.equal(validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256,
  candidate,
  expected: golden.document,
  independentTextByPage: pipeDelimitedEvidence,
  projection,
}).rows.length, 123, "pipe-delimited OCR is presentation-equivalent evidence");
const printedAmountEvidence = new Map([...textByPage].map(([page, text]) => [page,
  text.replaceAll(" - $", "-$").replaceAll("Spouse/DC Asset Over", "Spouse/DC Amount over"),
]));
assert.equal(validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256, candidate, expected: golden.document,
  independentTextByPage: printedAmountEvidence, projection,
}).rows.length, 123, "printed K wording and amount dash spacing preserve the same values");
for (const wrongAmount of ["Over $50,000,000", "Spouse/DC Amount over $5,000,000"]) {
  const incorrect = new Map(printedAmountEvidence);
  incorrect.set(1, incorrect.get(1)!.replace("Spouse/DC Amount over $1,000,000", wrongAmount));
  assert.throws(() => validateHouseDocumentRowCandidate({
    artifactDigest: golden.sha256, candidate, expected: golden.document,
    independentTextByPage: incorrect, projection,
  }), /source_relationship_invalid/u, "K cannot match a different amount or J");
}
const missingPageEvidence = new Map(textByPage);
missingPageEvidence.delete(5);
assert.throws(() => validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256,
  candidate,
  expected: golden.document,
  independentTextByPage: missingPageEvidence,
  projection,
}), /independent_value_mismatch/u);
const blankPageEvidence = new Map(textByPage);
blankPageEvidence.set(5, "   ");
assert.throws(() => validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256,
  candidate,
  expected: golden.document,
  independentTextByPage: blankPageEvidence,
  projection,
}), /independent_value_mismatch/u);
const zeroPageProjection = { ...projection, pages: [projection.pages[0]!] };
const zeroPageCandidate = {
  ...candidate,
  citations: [citations[0]!],
  fields: { ...candidate.fields, rows: [] },
};
const explicitZeroPageEvidence = new Map([[1,
  "Periodic Transaction Report; filerName=MICHAEL MCCAUL; filingDate=3/10/2026; reportStatus=legacy_grid_no_status; no_transaction_rows=true",
]]);
assert.deepEqual(validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256,
  candidate: zeroPageCandidate,
  expected: golden.document,
  independentTextByPage: explicitZeroPageEvidence,
  projection: zeroPageProjection,
}).rows, []);
assert.deepEqual(validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256, candidate: zeroPageCandidate, expected: golden.document,
  independentTextByPage: new Map([[1, explicitZeroPageEvidence.get(1)!.replace("no_transaction_rows=true", "No reportable transactions")]]),
  projection: zeroPageProjection,
}).rows, [], "an explicit no-transactions statement remains valid without an OCR-only marker");
assert.throws(() => validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256,
  candidate: zeroPageCandidate,
  expected: golden.document,
  independentTextByPage: new Map([[1,
    "Periodic Transaction Report; filerName=MICHAEL MCCAUL; filingDate=3/10/2026; reportStatus=legacy_grid_no_status",
  ]]),
  projection: zeroPageProjection,
}), /independent_value_mismatch|source_relationship_invalid/u,
"an unparseable zero-row page must never be inferred as empty");

class Memory {
  readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async createOrRead(key: string, value: string) {
    const previous = this.values.get(key);
    if (previous !== undefined) return { created: false, value: previous };
    this.values.set(key, value); return { created: true, value };
  }
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next); return true;
  }
}
const memory = new Memory();
const blobs = new Map<string, Uint8Array>();
const artifacts = createHybridEvidenceArtifactStore({ index: memory, blob: {
  async get(key) { return blobs.get(key) ?? null; },
  async put(key, value) { blobs.set(key, new Uint8Array(value)); },
  async delete(key) { blobs.delete(key); },
} });
const environment = {
  ...(live ? process.env : {}),
  EVE_HYBRID_EVIDENCE_AUTH_SECRET: randomBytes(32).toString("base64url"),
  EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS: live ? "anthropic/claude-haiku-4.5,google/gemini-3-flash" : "fixture/extractor,fixture/ocr",
  EVE_HYBRID_SOURCE_RECOVERY_INPUT_TOKENS_PER_DAY: "500000",
  EVE_HYBRID_SOURCE_RECOVERY_OUTPUT_TOKENS_PER_DAY: "100000",
};
let extractionCalls = 0;
// Every signed job in this harness is isolated in memory. Do not require or
// persist a production signing key, including under Vercel's local env runner.
if (live) process.env.EVE_HYBRID_EVIDENCE_AUTH_SECRET = environment.EVE_HYBRID_EVIDENCE_AUTH_SECRET;
let ocrCalls = 0;
const recovery = live ? HOUSE_HYBRID_EVIDENCE_RECOVERY_REGISTRATION.create({
  clients: { artifacts, jobs: memory, lineage: memory, globalBudget: memory },
  environment, initiatingWorkspaceId: "123e4567-e89b-42d3-a456-426614175599",
  modelIds: ["anthropic/claude-haiku-4.5", "google/gemini-3-flash"], reasoning: "provider-default",
}) : createHouseHybridEvidenceRecovery({
  allowedModelIds: ["fixture/extractor", "fixture/ocr"], environment,
  initiatingWorkspaceId: "123e4567-e89b-42d3-a456-426614175599", modelId: "fixture/extractor",
  clients: { artifacts, jobs: memory, lineage: memory, globalBudget: memory },
  dependencies: {
    async generateCandidate() {
      extractionCalls += 1;
      return { candidate: recordedOutput?.candidate ?? candidate,
        usage: recordedOutput?.extractionUsage ?? { inputTokens: 16000, outputTokens: 14000, paidCostUsd: "0.086" } };
    },
    ocr: { async recognize({ page }) {
      ocrCalls += 1;
      return { text: replayTextByPage.get(page)!, usage: recordedOutput ? replayOcrUsage(recordedOutput, page) :
        { inputTokens: 1000, outputTokens: 2000, paidCostUsd: "0.0065" } };
    } },
  },
});
const zip = new ZipWriter(new Uint8ArrayWriter());
await zip.add("2026FD.xml", new TextReader(`<FinancialDisclosure><Member><Prefix>Hon.</Prefix><Last>McCaul</Last><First>Michael T.</First><Suffix/><FilingType>P</FilingType><StateDst>TX10</StateDst><Year>2026</Year><FilingDate>3/10/2026</FilingDate><DocID>8221359</DocID></Member></FinancialDisclosure>`));
const archive = await zip.close();
let capturedRecoveryInput: Parameters<typeof recovery.recover>[0] | undefined;
let recoveredGolden: Awaited<ReturnType<typeof recovery.recover>> = null;
function capturePublicRecoveryOutput(store: Memory): PublicRecoveryOutput {
  const records = [...store.values.values()].flatMap((raw) => {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      return value.recordType === "hybrid_evidence_job_record" ? [value] : [];
    } catch {
      return [];
    }
  });
  assert.equal(records.length, 1, "the isolated canary must produce exactly one recovery record");
  const record = records[0]!;
  const independent = record.independentEvidence as Record<string, unknown> | null;
  assert.ok(record.candidate, "the canary did not produce a candidate to capture");
  assert.equal(independent?.state, "completed", "the canary did not complete independent OCR");
  return parsePublicRecoveryOutput({
    candidate: record.candidate,
    extractionUsage: record.extractionUsage,
    independentEvidence: {
      pageUsage: independent?.pageUsage,
      textByPage: independent?.textByPage,
      usage: independent?.usage,
    },
    schemaVersion: 1,
  });
}
const acquire = (observedAt: string) => runHousePublicSourceAcquisition({
  client: memory, hybridLineageClient: memory,
  recovery: { async recover(input) {
    capturedRecoveryInput = input;
    recoveredGolden = await recovery.recover(input);
    return recoveredGolden;
  } },
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  fetchDocument: async (url) => ({ body: pdf, contentType: "application/pdf", requestedUrl: url, finalUrl: url, status: 200, observedAt }),
  fetchIndex: async (url) => ({ body: archive, contentType: "application/zip", requestedUrl: url, finalUrl: url, status: 200, observedAt }),
  window: { startAt: "2026-08-30T00:00:00.000Z", endAt: observedAt },
});
const first = await acquire("2026-08-30T12:00:00.000Z");
if (captureOutput) {
  const output = capturePublicRecoveryOutput(memory);
  await writeFile(captureOutput, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.info(`Captured public House recovery output to ${captureOutput}; no credentials, tokens, or job receipts were written.`);
}
if (live) console.info("Real-model canary accounting", (await readGlobalDispatchBudgetLedger(memory)).reservations);
assert.equal(first.acquisition.result.coverage, "complete");
assert.equal(first.acquisition.baselineEstablished, true);
assert.equal(first.acquisition.facts.length, 124, "123 transaction facts plus one filing");
assert.equal(first.acquisition.facts.filter((fact) => fact.payload.schemaVersion === "house-ptr-transaction/v1" && fact.payload.amountRange.upper === null).length, 2);
assert.deepEqual(recoveredGolden?.document, golden.document);
assert.deepEqual(comparableGoldenRows(recoveredGolden?.rows ?? []), expectedGoldenRows,
  "every golden row, including repeated transactions, must survive in order");
const scope = authorizeDeploymentWorkspaceStore({ ownerId: "owner_fixture", workspaceId: "123e4567-e89b-42d3-a456-426614175599" },
  { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" });
const sourceInstance = first.commit!.sourceInstance;
const monitorId = "7dd4968b-3cf6-4ac3-a36a-9567b9b71234";
const subscriptionId = derivePublicSourceSubscriptionId({ monitorId, sourceInstanceId: sourceInstance.sourceInstanceId, workspaceId: scope.workspaceId });
const packBinding = { bindingRevision: 1, packContentDigest: "a".repeat(64), packId: "congressional-signals" as const, packVersion: "1.0.0" as const };
await ensurePublicSourceSubscription(scope, publicSourceSubscriptionSchema.parse({
  adapterDefinitionDigest: sourceInstance.adapterDefinitionDigest, adapterVersion: sourceInstance.adapterVersion,
  deliveryCursor: { lastAcquisitionId: null, revision: 0 }, factSchemaVersions: ["house-ptr-filing/v1", "house-ptr-transaction/v1"],
  filter: { kind: "all" }, lifecycleState: "active", monitorId, packBinding,
  recordType: "public_source_subscription", schemaVersion: 1, sourceInstanceId: sourceInstance.sourceInstanceId,
  subscriptionId, workspaceId: scope.workspaceId,
}), memory);
const projected = await projectPublicSourceAcquisition({ acquisition: first.acquisition.result,
  projectedAt: new Date("2026-08-30T12:00:00.000Z"), scope, subscriptionId }, { acquisition: memory, subscription: memory });
const evaluation = evaluateCongressionalFiling({ catalogs: {
  committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
  member: CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1, security: CONGRESSIONAL_SECURITY_CATALOG_V1,
}, filing: projected.projections.find(({ fact }) => fact.factSchemaVersion === "house-ptr-filing/v1")!,
  transactions: projected.projections.filter(({ fact }) => fact.factSchemaVersion === "house-ptr-transaction/v1"),
  minimumAlertBand: "review", observedAt: "2026-08-30T12:00:00.000Z", packBinding,
  policy: CONGRESSIONAL_POLICY_V1, processingMode: "baseline", selectedMemberBioguideIds: [],
});
assert.equal(evaluation.transactions.length, 123);
assert.equal(evaluation.transactions.filter(({ amountRange }) => amountRange.lower === "1000001" && amountRange.upper === null).length, 2);
assert.equal(evaluation.signal.alertEligible, false, "baseline transactions must never produce historical alerts");
assert.equal(evaluation.finding, null);
const ledger = await readGlobalDispatchBudgetLedger(memory);
assert.equal(ledger.reservations.at(-1)!.state, "settled");
if (!live) assert.equal(ledger.reservations.at(-1)!.reconciledPaidMicros,
  recordedOutput ? capturedPaidMicros(recordedOutput).toString() : "118500");
else assert.ok(BigInt(ledger.reservations.at(-1)!.reconciledPaidMicros!) <= 1000000n);
const second = await acquire("2026-08-30T13:00:00.000Z");
assert.equal(second.acquisition.result.status, "no_change");
if (!live) {
assert.equal(extractionCalls, 1);
assert.equal(ocrCalls, 5);
const replayAccountingFixture = parsePublicRecoveryOutput({
  ...capturePublicRecoveryOutput(memory),
  extractionUsage: { inputTokens: 100, outputTokens: 200, paidCostUsd: "0.0123" },
  independentEvidence: { textByPage: [...textByPage], pageUsage: [],
    usage: { inputTokens: 300, outputTokens: 400, paidCostUsd: "0.0234" } },
});
assert.equal(capturedPaidMicros(replayAccountingFixture), 35700n);
assert.deepEqual([1, 2, 3, 4, 5].map((page) => replayOcrUsage(replayAccountingFixture, page)), [
  { inputTokens: 300, outputTokens: 400, paidCostUsd: "0.0234" },
  ...Array.from({ length: 4 }, () => ({ inputTokens: 0, outputTokens: 0, paidCostUsd: "0" })),
]);
// One failed OCR page must preserve the extraction and every paid sibling page.
const retryMemory = new Memory();
let retryExtractions = 0;
const retryOcrCalls = new Map<number, number>();
const retryRecovery = createHouseHybridEvidenceRecovery({
  allowedModelIds: ["fixture/extractor", "fixture/ocr"], environment,
  initiatingWorkspaceId: "123e4567-e89b-42d3-a456-426614175599", modelId: "fixture/extractor",
  clients: { artifacts: createHybridEvidenceArtifactStore({ index: retryMemory, blob: {
    async get(key) { return blobs.get(key) ?? null; }, async put(key, value) { blobs.set(key, new Uint8Array(value)); },
    async delete(key) { blobs.delete(key); },
  } }), jobs: retryMemory, lineage: retryMemory, globalBudget: retryMemory },
  dependencies: {
    async generateCandidate() { retryExtractions++; return { candidate, usage: { inputTokens: 16000, outputTokens: 14000, paidCostUsd: "0.086" } }; },
    ocr: { async recognize({ page }) {
      const count = (retryOcrCalls.get(page) ?? 0) + 1; retryOcrCalls.set(page, count);
      if (page === 3 && count === 1) throw new Error("fixture_ocr_transport_failure");
      return { text: textByPage.get(page)!, usage: { inputTokens: 1000, outputTokens: 2000, paidCostUsd: "0.0065" } };
    } },
  },
});
assert.ok(capturedRecoveryInput);
assert.equal(await retryRecovery.recover(capturedRecoveryInput), null);
const retried = await retryRecovery.recover(capturedRecoveryInput);
assert.equal(retried?.rows.length, 123);
assert.equal(retryExtractions, 1);
assert.deepEqual([...retryOcrCalls.entries()].sort(), [[1, 1], [2, 1], [3, 2], [4, 1], [5, 1]]);
const retryLedger = await readGlobalDispatchBudgetLedger(retryMemory);
assert.deepEqual(retryLedger.reservations.map(({ state }) => state), ["uncertain", "settled"]);
assert.equal(retryLedger.reservations[0]!.reconciledInputTokens ?? retryLedger.reservations[0]!.inputTokens, 140000);
assert.equal(retryLedger.reservations[0]!.reconciledOutputTokens ?? retryLedger.reservations[0]!.outputTokens, 40000);
assert.equal(retryLedger.reservations.at(-1)!.reconciledPaidMicros, "6500");

// A storage acknowledgement can be lost after the OCR completion CAS has
// committed. Replay must settle the exact durable usage in both ledgers without
// issuing extraction or OCR again.
class CasThenThrowMemory extends Memory {
  private throwAfterCompletedOcrWrite = true;
  constructor(private readonly omitExtractionUsage = false) { super(); }

  override async compareAndSet(key: string, expected: string | null, next: string) {
    const committed = await super.compareAndSet(key, expected, next);
    const record = JSON.parse(next) as { independentEvidence?: { state?: string }; recordType?: string };
    if (committed && this.throwAfterCompletedOcrWrite && record.recordType === "hybrid_evidence_job_record" &&
      record.independentEvidence?.state === "completed") {
      this.throwAfterCompletedOcrWrite = false;
      if (this.omitExtractionUsage) this.values.set(key, JSON.stringify({ ...JSON.parse(next), extractionUsage: null }));
      throw new Error("fixture_ocr_completed_cas_then_throw");
    }
    return committed;
  }
}
async function verifyLostOcrAcknowledgement(missingUsage = false) {
const faultMemory = new CasThenThrowMemory(missingUsage);
const faultBlobs = new Map<string, Uint8Array>();
const faultScope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture", workspaceId: "123e4567-e89b-42d3-a456-426614175599",
}, { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" });
const faultEnvironment = {
  ...environment,
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
};
const faultPolicy = {
  effectiveAt: "2026-08-30T00:00:00.000Z",
  maximumConcurrentWorkers: 1,
  maximumInputTokensPerDay: 200_000,
  maximumInputTokensPerRun: 200_000,
  maximumOutputTokensPerDay: 100_000,
  maximumOutputTokensPerRun: 100_000,
  maximumPaidPerCall: "1.000000",
  maximumPaidPerDay: "10.000000",
  maximumPaidPerMonth: "100.000000",
  maximumScheduledRunsPerDay: 8,
  ownerTimezone: "UTC",
  unknownPriceFallbackCeiling: "1.000000",
} as const;
const faultNow = new Date();
await writeWorkspaceDocument("budget", {
  expectedRevision: 0,
  now: faultNow,
  scope: faultScope,
  value: faultPolicy,
}, faultMemory);
await reserveWorkspaceRunBudget({
  inputTokens: 200_000,
  kind: "scheduled_monitor",
  now: faultNow,
  outputTokens: 100_000,
  policy: faultPolicy,
  policyRevision: 1,
  runId: "fault-parent-run",
  scope: faultScope,
}, faultMemory);
assert.deepEqual((await readWorkspaceBudgetLedger(faultScope, faultMemory)).reservations.map((reservation) => ({
  kind: reservation.kind, parentRunId: reservation.parentRunId, policyRevision: reservation.policyRevision,
  runId: reservation.runId, state: reservation.state,
})), [{
  kind: "scheduled_monitor", parentRunId: null, policyRevision: 1,
  runId: "fault-parent-run", state: "reserved",
}]);
let faultExtractions = 0;
let faultOcrCalls = 0;
const faultRecovery = createHouseHybridEvidenceRecovery({
  allowedModelIds: ["fixture/extractor", "fixture/ocr"],
  budgetScope: faultScope,
  clients: {
    artifacts: createHybridEvidenceArtifactStore({ index: faultMemory, blob: {
      async get(key) { return faultBlobs.get(key) ?? null; },
      async put(key, value) { faultBlobs.set(key, new Uint8Array(value)); },
      async delete(key) { faultBlobs.delete(key); },
    } }),
    globalBudget: faultMemory,
    jobs: faultMemory,
    lineage: faultMemory,
    state: faultMemory,
    workspaceBudget: faultMemory,
  },
  dependencies: {
    async generateCandidate() {
      faultExtractions += 1;
      return { candidate, usage: { inputTokens: 16_000, outputTokens: 14_000, paidCostUsd: "0.086" } };
    },
    ocr: { async recognize({ page }) {
      faultOcrCalls += 1;
      return { text: textByPage.get(page)!, usage: { inputTokens: 1_000, outputTokens: 2_000, paidCostUsd: "0.0065" } };
    } },
  },
  environment: faultEnvironment,
  initiatingWorkspaceId: faultScope.workspaceId,
  modelId: "fixture/extractor",
  parentBudgetRunId: "fault-parent-run",
});
assert.ok(capturedRecoveryInput);
assert.equal(await faultRecovery.recover(capturedRecoveryInput), null);
const globalAtFault = await readGlobalDispatchBudgetLedger(faultMemory);
const workspaceAtFault = await readWorkspaceBudgetLedger(faultScope, faultMemory);
if (missingUsage) {
  assert.equal(globalAtFault.reservations.at(-1)!.state, "uncertain", "missing durable usage is not settled actual spend");
  assert.equal(globalAtFault.reservations.at(-1)!.reconciledPaidMicros, null);
  assert.equal(workspaceAtFault.reservations.find(({ parentRunId }) => parentRunId === "fault-parent-run")?.state, "uncertain");
  return;
}
assert.equal(globalAtFault.reservations.at(-1)!.state, "settled");
assert.equal(globalAtFault.reservations.at(-1)!.reconciledInputTokens, 21_000);
assert.equal(globalAtFault.reservations.at(-1)!.reconciledOutputTokens, 24_000);
assert.equal(globalAtFault.reservations.at(-1)!.reconciledPaidMicros, "118500");
const faultWorkspaceReservation = workspaceAtFault.reservations.find(({ parentRunId }) => parentRunId === "fault-parent-run");
assert.equal(faultWorkspaceReservation?.state, "reconciled");
assert.equal(faultWorkspaceReservation?.reconciledInputTokens, 21_000);
assert.equal(faultWorkspaceReservation?.reconciledOutputTokens, 24_000);
assert.equal(faultWorkspaceReservation?.reconciledPaidMicros, "118500");
const faultReplay = await faultRecovery.recover(capturedRecoveryInput);
assert.equal(faultReplay?.rows.length, 123);
assert.equal(faultExtractions, 1);
assert.equal(faultOcrCalls, 5);
assert.deepEqual(await readGlobalDispatchBudgetLedger(faultMemory), globalAtFault);
assert.deepEqual(await readWorkspaceBudgetLedger(faultScope, faultMemory), workspaceAtFault);
}
await verifyLostOcrAcknowledgement();
await verifyLostOcrAcknowledgement(true);
}
console.info(`Exact House 8221359 verification passed: 123 transactions, 2 K rows, complete canonical acquisition, baseline without alerts, settled accounting, unchanged replay (${live ? "real models; isolated test storage" : "offline fixtures; no spend"}).`);
