import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  EARNINGS_CALL_LIMITS,
} from "../agent/lib/earnings-call-schema";
import {
  buildEarningsCallEvidenceTimeline,
  createEarningsCallComparison,
} from "../agent/lib/earnings-call-comparison";
import {
  compareEarningsCallLanguage,
  measureEarningsCallLanguage,
} from "../agent/lib/earnings-call-language-metrics";
import {
  createEarningsCallCitation,
  normalizeEarningsCallTranscript,
  planEarningsCallEvidenceJobs,
  validateEarningsCallTranscriptRecoveryCandidate,
} from "../agent/lib/earnings-call-transcript";
import {
  createExtractionRecoveryDefinitions,
  EARNINGS_CALL_TRANSCRIPT_LAYOUT_DEFINITION_ID,
  resolveExtractionRecoveryDefinition,
} from "../agent/lib/hybrid-evidence-definition-registry";

const encoder = new TextEncoder();
const digestBytes = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function event(input: {
  readonly artifactDigest: string;
  readonly callDate: string;
  readonly fiscalPeriod: string;
  readonly publishedAt: string;
  readonly revision?: number;
}) {
  const revision = input.revision ?? 1;
  return {
    artifactByteCount: 1_024,
    artifactDigest: input.artifactDigest,
    callDate: input.callDate,
    cik: "0000789019",
    eventId: `event.0000789019.${input.callDate}`,
    fiscalPeriod: input.fiscalPeriod,
    observedAt: input.publishedAt,
    publishedAt: input.publishedAt,
    recordType: "earnings_call_event" as const,
    revision,
    revisionId: `event-revision.0000789019.${input.callDate}.${revision}`,
    schemaVersion: 1 as const,
    secAccession: null,
    sourceInstanceId: "source.earnings-call-transcripts.0000789019",
  };
}

function transcriptHtml(period: string, prepared: string, question: string, answer: string) {
  return `<!doctype html><html><body>
    <h1>Microsoft ${period} Earnings Conference Call Transcript</h1>
    <h2>Prepared Remarks</h2>
    <p>Jordan Lee (Chief Executive Officer): ${prepared}</p>
    <p>Priya Shah (Chief Financial Officer): We are committed to disciplined execution.</p>
    <h2>Questions and Answers</h2>
    <p>Alex Kim (Analyst): ${question}</p>
    <p>Jordan Lee (Chief Executive Officer): ${answer}</p>
    <p>Operator: This concludes the question-and-answer session.</p>
  </body></html>`;
}

async function normalize(input: {
  readonly fiscalPeriod: string;
  readonly html: string;
  readonly revisionId: string;
}) {
  const bytes = encoder.encode(input.html);
  return normalizeEarningsCallTranscript({
    artifactBytes: bytes,
    artifactDigest: digestBytes(bytes),
    artifactMediaType: "text/html",
    eventRevisionId: input.revisionId,
    fiscalPeriod: input.fiscalPeriod,
  });
}

let currentEvent = event({
  artifactDigest: "a".repeat(64),
  callDate: "2026-04-29",
  fiscalPeriod: "FY2026-Q3",
  publishedAt: "2026-04-29T21:00:00.000Z",
});
const current = await normalize({
  fiscalPeriod: currentEvent.fiscalPeriod,
  html: transcriptHtml(
    "FY2026 Q3",
    "We are confident and on track. Revenue grew 12% and we expect to deliver by June.",
    "How should we think about next quarter revenue growth?",
    "We expect revenue growth of 10% to 12% next quarter, supported by strong visibility.",
  ),
  revisionId: currentEvent.revisionId,
});
assert.equal(current.state, "accepted");
if (current.state !== "accepted") throw new Error("expected accepted transcript");
currentEvent = { ...currentEvent, artifactDigest: current.transcript.artifactDigest };
assert.deepEqual(current.transcript.sections.map(({ sectionKind }) => sectionKind), [
  "prepared_remarks",
  "questions_and_answers",
]);
assert.ok(current.transcript.speakerTurns.some(({ role }) => role === "executive"));
assert.ok(current.transcript.speakerTurns.some(({ role }) => role === "analyst"));
assert.equal(current.transcript.qaPairs.length, 1);
assert.equal(current.transcript.coverage.preparedRemarks, "document_complete");
assert.equal(current.transcript.coverage.questionsAndAnswers, "document_complete");
assert.equal(current.transcript.coverage.liveCallCompleteness, "not_attested");

const prepared = current.transcript.sections.find(({ sectionKind }) => sectionKind === "prepared_remarks")!;
const citation = createEarningsCallCitation({
  artifactDigest: current.transcript.artifactDigest,
  end: prepared.end,
  eventRevisionId: current.transcript.eventRevisionId,
  normalizedText: current.normalizedText,
  sectionId: prepared.sectionId,
  start: prepared.start,
  transcript: current.transcript,
});
assert.equal(citation.spanDigest.length, 64);
assert.throws(() => createEarningsCallCitation({
  artifactDigest: current.transcript.artifactDigest,
  end: prepared.end + 10_000,
  eventRevisionId: current.transcript.eventRevisionId,
  normalizedText: current.normalizedText,
  sectionId: prepared.sectionId,
  start: prepared.start,
  transcript: current.transcript,
}), /citation_invalid/u);

const negativeFixture = JSON.parse(await readFile(
  new URL("./fixtures/earnings-call-changes/source-negative-fixtures.json", import.meta.url),
  "utf8",
)) as { fixtures: readonly Record<string, unknown>[] };
for (const fixture of negativeFixture.fixtures) {
  if (typeof fixture.syntheticText !== "string" || fixture.id === "changed-layout") continue;
  const bytes = encoder.encode(`<html><body>${fixture.syntheticText}</body></html>`);
  const outcome = await normalizeEarningsCallTranscript({
    artifactBytes: bytes,
    artifactDigest: digestBytes(bytes),
    artifactMediaType: "text/html",
    eventRevisionId: "event-revision.fixture.1",
    fiscalPeriod: "FY2026-Q3",
  });
  assert.equal(outcome.state, fixture.expectedState, String(fixture.id));
  assert.equal(outcome.reason, fixture.expectedReason, String(fixture.id));
}
const oversized = await normalizeEarningsCallTranscript({
  artifactBytes: new Uint8Array(EARNINGS_CALL_LIMITS.maximumArtifactBytes + 1),
  artifactDigest: "f".repeat(64),
  artifactMediaType: "text/html",
  eventRevisionId: "event-revision.oversized.1",
  fiscalPeriod: "FY2026-Q3",
});
assert.deepEqual(oversized, { reason: "artifact_oversized", state: "quarantined" });
await assert.rejects(normalizeEarningsCallTranscript({
  artifactBytes: encoder.encode("<html><body>tampered</body></html>"),
  artifactDigest: "e".repeat(64),
  artifactMediaType: "text/html",
  eventRevisionId: "event-revision.tampered.1",
  fiscalPeriod: "FY2026-Q3",
}), /artifact_digest_mismatch/u);

let priorEvent = event({
  artifactDigest: "b".repeat(64),
  callDate: "2026-01-28",
  fiscalPeriod: "FY2026-Q2",
  publishedAt: "2026-01-28T21:00:00.000Z",
});
const prior = await normalize({
  fiscalPeriod: priorEvent.fiscalPeriod,
  html: transcriptHtml(
    "FY2026 Q2",
    "We believe revenue may grow around 8% as macro headwinds continue.",
    "Could you discuss the outlook?",
    "We think growth could be approximately 8% next quarter.",
  ),
  revisionId: priorEvent.revisionId,
});
assert.equal(prior.state, "accepted");
if (prior.state !== "accepted") throw new Error("expected accepted prior transcript");
priorEvent = { ...priorEvent, artifactDigest: prior.transcript.artifactDigest };

const directMetrics = compareEarningsCallLanguage({
  current: { section: "prepared-remarks", text: "We are confident. Revenue grew 12%." },
  prior: { section: "prepared-remarks", text: "We believe revenue may grow." },
});
assert.ok(directMetrics.change!.confidencePerThousandWords > 0);
assert.equal(
  measureEarningsCallLanguage({ section: "qa", text: "Inflation may affect next quarter." })
    .externalAttribution.count,
  1,
);

const comparison = createEarningsCallComparison({
  current: { event: currentEvent, normalizedText: current.normalizedText, transcript: current.transcript },
  prior: { event: priorEvent, normalizedText: prior.normalizedText, transcript: prior.transcript },
});
assert.equal(comparison.prior.fiscalPeriod, "FY2026-Q2");
assert.equal(comparison.metrics.length, 8);
assert.deepEqual(new Set(comparison.metrics.map(({ sectionKind }) => sectionKind)), new Set([
  "prepared_remarks",
  "questions_and_answers",
]));
assert.throws(() => createEarningsCallComparison({
  current: { event: currentEvent, normalizedText: current.normalizedText, transcript: current.transcript },
  prior: {
    event: { ...priorEvent, fiscalPeriod: "FY2025-Q3" },
    normalizedText: prior.normalizedText,
    transcript: prior.transcript,
  },
}), /comparison_period_not_immediately_prior/u);

const correctedEvent = event({
  ...currentEvent,
  artifactDigest: "c".repeat(64),
  revision: 2,
});
const timeline = buildEarningsCallEvidenceTimeline({
  activationWatermark: "2026-04-01T00:00:00.000Z",
  baselineBackfill: true,
  records: [
    { event: priorEvent, normalizedText: prior.normalizedText, transcript: prior.transcript },
    { event: currentEvent, normalizedText: current.normalizedText, transcript: current.transcript },
    { event: correctedEvent, normalizedText: current.normalizedText, transcript: {
      ...current.transcript,
      artifactDigest: correctedEvent.artifactDigest,
      eventRevisionId: correctedEvent.revisionId,
      transcriptId: `${current.transcript.transcriptId}.corrected`,
    } },
  ],
});
assert.ok(timeline.records.length <= 4);
assert.equal(timeline.alertEligibleRevisionIds.length, 0, "baseline backfill must be silent");
assert.equal(timeline.corrections.length, 1);
assert.equal(timeline.corrections[0]?.reason, "artifact_digest_changed");
assert.equal(timeline.corrections[0]?.correctiveAlertEligible, false);

const newEvent = event({
  artifactDigest: "d".repeat(64),
  callDate: "2026-07-29",
  fiscalPeriod: "FY2026-Q4",
  publishedAt: "2026-07-29T21:00:00.000Z",
});
const activeTimeline = buildEarningsCallEvidenceTimeline({
  activationWatermark: "2026-04-30T00:00:00.000Z",
  baselineBackfill: false,
  records: [
    { event: currentEvent, normalizedText: current.normalizedText, transcript: current.transcript },
    { event: newEvent, normalizedText: current.normalizedText, transcript: {
      ...current.transcript,
      artifactDigest: newEvent.artifactDigest,
      eventRevisionId: newEvent.revisionId,
      transcriptId: `${current.transcript.transcriptId}.next`,
    } },
  ],
});
assert.deepEqual(activeTimeline.alertEligibleRevisionIds, [newEvent.revisionId]);

const singlePlan = planEarningsCallEvidenceJobs({
  normalizedText: current.normalizedText,
  transcript: current.transcript,
});
assert.equal(singlePlan.state, "single_job");
assert.equal(singlePlan.documentCoverage, "complete");

const longPreparedText = "We are confident in execution and expect measured progress. ".repeat(900);
const longQuestion = "How should investors evaluate the next quarter outlook? ".repeat(80);
const longAnswer = "We expect disciplined progress with clear milestones. ".repeat(280);
const longResult = await normalize({
  fiscalPeriod: "FY2026-Q3",
  html: transcriptHtml("FY2026 Q3", longPreparedText, longQuestion, longAnswer),
  revisionId: "event-revision.long.1",
});
assert.equal(longResult.state, "accepted");
if (longResult.state !== "accepted") throw new Error("expected accepted long transcript");
const sectionedPlan = planEarningsCallEvidenceJobs({
  normalizedText: longResult.normalizedText,
  transcript: longResult.transcript,
});
assert.equal(sectionedPlan.state, "sectioned");
assert.ok(sectionedPlan.jobs.length <= 4);
assert.ok(sectionedPlan.aggregateInputTokens <= 24_000);
assert.equal(
  sectionedPlan.jobs.reduce((total, job) => total + job.spans.reduce(
    (sum, span) => sum + span.end - span.start,
    0,
  ), 0),
  longResult.transcript.sections.reduce((total, section) => total + section.characterCount, 0),
  "sectioning must cover every prepared/Q&A character",
);

const changedLayout = [
  "Microsoft FY2026 Q3 Earnings Conference Call Transcript",
  "CALL PARTICIPANTS",
  "Jordan Lee (Chief Executive Officer)",
  "Alex Kim (Analyst)",
  "PREPARED DISCUSSION",
  "Jordan Lee (Chief Executive Officer): We are confident in execution.",
  "ANALYST DIALOGUE",
  "Alex Kim (Analyst): What changed in the outlook?",
  "Jordan Lee (Chief Executive Officer): We expect 10% growth next quarter.",
].join("\n");
const changedBytes = encoder.encode(`<html><body>${changedLayout.replaceAll("\n", "<p>")}</body></html>`);
const changed = await normalizeEarningsCallTranscript({
  artifactBytes: changedBytes,
  artifactDigest: digestBytes(changedBytes),
  artifactMediaType: "text/html",
  eventRevisionId: "event-revision.changed.1",
  fiscalPeriod: "FY2026-Q3",
});
assert.equal(changed.state, "recovery_required");
if (changed.state !== "recovery_required") throw new Error("expected recovery");

const definitions = createExtractionRecoveryDefinitions(["fixture/model"]);
const transcriptDefinition = definitions.find(
  ({ definitionId }) => definitionId === EARNINGS_CALL_TRANSCRIPT_LAYOUT_DEFINITION_ID,
)!;
assert.deepEqual(transcriptDefinition.allowedMediaTypes, ["application/pdf", "text/html"]);
assert.equal(resolveExtractionRecoveryDefinition({
  adapterId: "earnings-call-transcripts",
  mediaType: "text/html",
  modelIds: ["fixture/model"],
  parserCode: "transcript_layout_changed",
})?.definitionId, EARNINGS_CALL_TRANSCRIPT_LAYOUT_DEFINITION_ID);

const preparedStart = changed.sourceText.indexOf("PREPARED DISCUSSION");
const qaStart = changed.sourceText.indexOf("ANALYST DIALOGUE");
const jordanPreparedStart = changed.sourceText.indexOf("Jordan Lee", preparedStart);
const analystStart = changed.sourceText.indexOf("Alex Kim", qaStart);
const jordanAnswerStart = changed.sourceText.indexOf("Jordan Lee", analystStart);
const recovered = validateEarningsCallTranscriptRecoveryCandidate({
  artifactDigest: changed.artifactDigest,
  candidate: {
    qaPairs: [{ answerTurnIndexes: [2], questionTurnIndexes: [1] }],
    sections: [
      { end: qaStart, sectionKind: "prepared_remarks", start: preparedStart },
      { end: changed.sourceText.length, sectionKind: "questions_and_answers", start: qaStart },
    ],
    speakerTurns: [
      { end: qaStart, role: "executive", speakerName: "Jordan Lee", start: jordanPreparedStart },
      { end: jordanAnswerStart, role: "analyst", speakerName: "Alex Kim", start: analystStart },
      { end: changed.sourceText.length, role: "executive", speakerName: "Jordan Lee", start: jordanAnswerStart },
    ],
  },
  eventRevisionId: "event-revision.changed.1",
  sourceText: changed.sourceText,
});
assert.equal(recovered.qaPairs.length, 1);
assert.throws(() => validateEarningsCallTranscriptRecoveryCandidate({
  artifactDigest: changed.artifactDigest,
  candidate: {
    qaPairs: [{ answerTurnIndexes: [2], questionTurnIndexes: [1] }],
    sections: [
      { end: qaStart + 5, sectionKind: "prepared_remarks", start: preparedStart },
      { end: changed.sourceText.length, sectionKind: "questions_and_answers", start: qaStart },
    ],
    speakerTurns: [
      { end: qaStart, role: "executive", speakerName: "Jordan Lee", start: jordanPreparedStart },
      { end: jordanAnswerStart, role: "analyst", speakerName: "Alex Kim", start: analystStart },
      { end: changed.sourceText.length, role: "executive", speakerName: "Jordan Lee", start: jordanAnswerStart },
    ],
  },
  eventRevisionId: "event-revision.changed.1",
  sourceText: changed.sourceText,
}), /recovered_boundary_invalid/u);

console.log("earnings call changes sprint 2 verification passed");
