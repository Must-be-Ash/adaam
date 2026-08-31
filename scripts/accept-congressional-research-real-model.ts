/** Bounded research-only acceptance on the public, independently validated 123-row
 * capture. No production stores, monitors, search, alerts, or trading are used.
 * Pass --live-max-usd=0.50 --capture-output=/absolute/path.json to purchase one
 * report-now session, or --replay=/absolute/path.json for free validation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { generateText, gateway, stepCountIs, tool } from "ai";
import { congressionalResearchEvidenceContent, congressionalResearchValidationContract,
  congressionalResearchWorkerCandidateSchema, createCongressionalResearchDefinition } from "../agent/lib/congressional-research";
import { houseDocumentRowWorkerCandidateSchema } from "../agent/lib/hybrid-evidence-extraction-recovery";
import { parseHouseTransactionAmountRange } from "../agent/lib/house-public-source-adapter";
import { hybridEvidenceResearchDecisionSchema } from "../agent/lib/hybrid-evidence-research";
import { publishCongressionalResearchReport, type CongressionalReportTransaction } from "../agent/lib/congressional-research-worker";
import { researchReportSchema } from "../agent/lib/artifact-schema";

const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const source = JSON.parse(await readFile(new URL("./fixtures/public-source-adapters/house/live-review-2026-08-30/ptr-8221359.real-models.json", import.meta.url), "utf8"));
const extracted = houseDocumentRowWorkerCandidateSchema.parse(source.candidate).fields;
assert.equal(extracted.rows.length, 123);
const canonicalUrl = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/${extracted.document.docId}.pdf`;
const reportTransactions: CongressionalReportTransaction[] = extracted.rows.map((row, index) => ({
  amountRange: parseHouseTransactionAmountRange(row.amountRange),
  asset: { description: row.assetDescription, reportedTicker: row.reportedTicker },
  disclosedMember: { firstName: "Michael T.", lastName: "McCaul" },
  filingDate: extracted.document.filingDate,
  lineage: { state: "active" },
  owner: { disclosedCode: row.ownerCode, relationship: row.ownerCode === "SP" ? "spouse" : row.ownerCode === "DC" ? "dependent_child" : "unknown" },
  source: { page: row.page, publicDocumentUrl: canonicalUrl, rowIdentity: `${extracted.document.docId}:${index + 1}` },
  transactionDate: row.transactionDate,
  transactionType: row.transactionType,
}));
// Project just the fields the production evidence builder consumes; extraction
// correctness is independently covered by verify-house-legacy-golden/replay.
const content = congressionalResearchEvidenceContent({ minimumAlertBand: "review", previousAlert: false,
  evaluation: { filing: { fact: { revisionId: "fixture.public.8221359" } }, signal: { band: "record_only" },
    transactions: extracted.rows.map((row) => ({
      source: { publicDocumentUrl: canonicalUrl }, filingDate: extracted.document.filingDate,
      disclosedMember: { firstName: "Michael T.", lastName: "McCaul" }, lineage: { correctionId: null },
      asset: { description: row.assetDescription, reportedTicker: row.reportedTicker },
      owner: { relationship: row.ownerCode === "SP" ? "spouse" : row.ownerCode === "DC" ? "dependent_child" : "unknown" },
      transactionType: row.transactionType, transactionDate: row.transactionDate, notificationDate: row.notificationDate,
      amountRange: parseHouseTransactionAmountRange(row.amountRange), eligibility: { reasonCodes: ["unresolved_security"] },
    })),
  } as never,
});
const digest = createHash("sha256").update(content).digest("hex");
const locator = { kind: "text_span", artifactDigest: digest, start: 0, end: content.length, spanDigest: digest } as const;
const modelId = "openai/gpt-5.4";
const definition = createCongressionalResearchDefinition([modelId]);
const replay = argument("replay");
let capture: { definitionDigest: string; evidenceDigest: string; decision: unknown; candidate: unknown; usage: unknown };
if (replay) capture = JSON.parse(await readFile(replay, "utf8"));
else {
  assert.equal(argument("live-max-usd"), "0.50", "An explicit --live-max-usd=0.50 is required");
  const outputPath = argument("capture-output");
  assert.ok(outputPath?.startsWith("/"), "An absolute public capture-output path is required");
  const prompt = [definition.instructionTemplate.content,
    "This is a bounded report-now acceptance on the official filing alone. Supplementary tools are unavailable; do not fabricate outside research or a ticker. First call decide_hybrid_evidence_research with report_now, then complete the job. You may abstain if the delayed filing supports no useful investment implication.",
    "Set citations to the supplied signed locator. Include at most eight material facts and three sources. Review all rows, preserve duplicate transactions and the distinct K category without inventing exact dollars or an upper bound.",
    `<citableLocators>${JSON.stringify([locator])}</citableLocators>`,
    `<untrusted_evidence>${content}</untrusted_evidence>`,
  ].join("\n");
  const available = await gateway.getAvailableModels();
  const pricing = available.models.find(({ id }) => id === modelId)?.pricing;
  assert.ok(pricing);
  const maximumInputTokens = Math.ceil(Buffer.byteLength(prompt) / 2) + 8_000;
  const quotedMaximumUsd = 3 * (maximumInputTokens * Math.max(Number(pricing.input), Number(pricing.cacheCreationInputTokens ?? pricing.input)) + 6_000 * Number(pricing.output));
  assert.ok(Number.isFinite(quotedMaximumUsd) && quotedMaximumUsd > 0 && quotedMaximumUsd <= 0.50,
    `Preflight quote exceeds the $0.50 cap: ${quotedMaximumUsd}`);
  let decision: unknown = null;
  const result = await generateText({ model: gateway(modelId), prompt, maxRetries: 0, maxOutputTokens: 6_000,
    abortSignal: AbortSignal.timeout(120_000), stopWhen: stepCountIs(3), toolChoice: "required",
    providerOptions: { openai: { reasoningEffort: "high" }, gateway: { cacheControl: "max-age=0", tags: ["feature:congressional-research", "env:acceptance"] } },
    tools: {
      decide_hybrid_evidence_research: tool({ description: "Persist the research decision.", inputSchema: hybridEvidenceResearchDecisionSchema,
        execute: async (value) => { assert.equal(value.decision, "report_now"); decision = value; return { state: "persisted" }; } }),
      complete_hybrid_evidence_job: tool({ description: "Complete one Congressional materiality decision and executive brief.", inputSchema: congressionalResearchWorkerCandidateSchema }),
    },
  });
  const call = result.toolCalls.find(({ toolName }) => toolName === "complete_hybrid_evidence_job");
  const costs = result.steps.map((step) => Number(step.providerMetadata?.gateway?.cost));
  capture = { definitionDigest: definition.definitionDigest, evidenceDigest: digest, decision,
    candidate: call?.input ?? null, usage: { inputTokens: result.totalUsage.inputTokens, outputTokens: result.totalUsage.outputTokens,
      paidCostUsd: costs.every((cost) => Number.isFinite(cost) && cost >= 0) ? costs.reduce((a, b) => a + b, 0).toFixed(6) : null,
      quotedMaximumUsd, modelId } };
  await writeFile(outputPath, JSON.stringify(capture, null, 2) + "\n");
}
assert.equal(capture.definitionDigest, definition.definitionDigest);
assert.equal(capture.evidenceDigest, digest);
assert.equal(hybridEvidenceResearchDecisionSchema.parse(capture.decision).decision, "report_now");
const candidate = congressionalResearchWorkerCandidateSchema.parse(capture.candidate);
const validated = congressionalResearchValidationContract.validate({ disposition: candidate.disposition,
  fields: candidate.fields, unknowns: candidate.unknowns, evidenceTexts: [{ content, locator }], inputProjection: {} });
assert.equal(validated.requireExactCitations, true);
let report: unknown;
await publishCongressionalResearchReport({ entries: [{ identity: digest, transactions: reportTransactions, brief: candidate.fields.brief }],
  scope: { ownerId: "owner_fixture", workspaceId: "123e4567-e89b-42d3-a456-426614175599" },
  asOf: extracted.document.filingDate, publishReport: async (input) => {
    report = researchReportSchema.parse(input.report); return { artifactId: input.artifactId, kind: "report" } as never;
  } });
console.log(JSON.stringify({ passed: true, mode: replay ? "offline_replay" : "real_model", rowCount: extracted.rows.length,
  decision: capture.decision, usage: capture.usage, band: candidate.fields.band, brief: candidate.fields.brief, reportValidated: !!report }, null, 2));
