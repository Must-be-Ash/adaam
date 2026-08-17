import { createHash } from "node:crypto";

import { z } from "zod";

import {
  digestEarningsCallValue,
  EARNINGS_CALL_LIMITS,
  EARNINGS_CALL_SCHEMA_VERSION,
  earningsCitationSchema,
  earningsTranscriptSchema,
  type EarningsTranscript,
} from "./earnings-call-schema";
import { EARNINGS_CALL_POLICY } from "./earnings-call-policy";
import { projectHybridEvidencePdf } from "./hybrid-evidence-pdf";

export const EARNINGS_CALL_TRANSCRIPT_PARSER_VERSION = "1.0.0";

type TranscriptSectionKind = "prepared_remarks" | "questions_and_answers";
type SpeakerRole = EarningsTranscript["speakerTurns"][number]["role"];

export type EarningsCallTranscriptNormalizationOutcome =
  | Readonly<{
      artifactDigest: string;
      normalizedText: string;
      state: "accepted";
      transcript: EarningsTranscript;
    }>
  | Readonly<{
      reason: "missing_qa" | "release_only";
      state: "coverage_unavailable";
    }>
  | Readonly<{
      artifactDigest: string;
      reason: "registered_layout_changed";
      sourceText: string;
      state: "recovery_required";
    }>
  | Readonly<{
      reason: "ambiguous_period" | "artifact_oversized" | "source_instruction_ignored";
      state: "quarantined";
    }>;

function htmlEntity(value: string): string {
  const named: Readonly<Record<string, string>> = Object.freeze({
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  });
  return value.replace(/&(?:#(\d{1,7})|#x([a-f0-9]{1,6})|([a-z]{2,8}));/giu,
    (match, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
      if (name) return named[name.toLowerCase()] ?? match;
      const point = Number.parseInt(decimal ?? hexadecimal ?? "", hexadecimal ? 16 : 10);
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    });
}

function normalizeLineText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v ]+/gu, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1]!.length > 0))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function htmlToText(value: string): string {
  const withoutExecutableContent = value
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "\n")
    .replace(/<!--(?:[\s\S]*?)-->/gu, "\n");
  return normalizeLineText(htmlEntity(withoutExecutableContent
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:address|article|aside|blockquote|div|footer|h[1-6]|header|li|main|p|section|table|td|th|tr)>/giu, "\n")
    .replace(/<(?:address|article|aside|blockquote|div|footer|h[1-6]|header|li|main|p|section|table|td|th|tr)\b[^>]*>/giu, "\n")
    .replace(/<[^>]+>/gu, "")));
}

function hostileInstructionDetected(text: string): boolean {
  return /(?:ignore|override|disregard).{0,100}(?:instruction|policy|schema|system|tool)|(?:send|message|call|execute|submit).{0,80}(?:broker|trade|order|owner)/iu.test(text);
}

function transcriptPeriod(text: string): string | null {
  const found = new Set<string>();
  for (const match of text.matchAll(/\bFY\s*(20\d{2})\s*[- ]?Q([1-4])\b/giu)) {
    found.add(`FY${match[1]}-Q${match[2]}`);
  }
  for (const match of text.matchAll(/\bQ([1-4])\s*(?:FY\s*)?(20\d{2})\b/giu)) {
    found.add(`FY${match[2]}-Q${match[1]}`);
  }
  const quarterNames: Readonly<Record<string, string>> = Object.freeze({
    first: "1", second: "2", third: "3", fourth: "4",
  });
  for (const match of text.matchAll(/\b(first|second|third|fourth) quarter(?: of)?(?: fiscal)?\s+(20\d{2})\b/giu)) {
    found.add(`FY${match[2]}-Q${quarterNames[match[1]!.toLowerCase()]}`);
  }
  return found.size === 1 ? [...found][0]! : null;
}

type TextRange = Readonly<{ end: number; start: number }>;

function findTranscriptHeadings(text: string): Readonly<{
  changedPrepared: TextRange | null;
  changedQa: TextRange | null;
  prepared: TextRange | null;
  qa: TextRange | null;
}> {
  let changedPrepared: TextRange | null = null;
  let changedQa: TextRange | null = null;
  let prepared: TextRange | null = null;
  let qa: TextRange | null = null;
  let cursor = 0;
  for (const line of text.split("\n")) {
    const start = cursor;
    const end = start + line.length;
    const trimmed = line.trim();
    if (!prepared && PREPARED_HEADING.test(trimmed)) prepared = Object.freeze({ end, start });
    if (!qa && QA_HEADING.test(trimmed)) qa = Object.freeze({ end, start });
    if (!changedPrepared && CHANGED_PREPARED_HEADING.test(trimmed)) {
      changedPrepared = Object.freeze({ end, start });
    }
    if (!changedQa && CHANGED_QA_HEADING.test(trimmed)) {
      changedQa = Object.freeze({ end, start });
    }
    cursor = end + 1;
  }
  return Object.freeze({ changedPrepared, changedQa, prepared, qa });
}

const PREPARED_HEADING = /^(?:prepared remarks|presentation)$/iu;
const QA_HEADING = /^(?:questions?\s*(?:and|&)\s*answers?|question-and-answer session|q\s*&\s*a)$/iu;
const CHANGED_PREPARED_HEADING = /^prepared discussion$/iu;
const CHANGED_QA_HEADING = /^analyst dialogue$/iu;

function speakerRole(speakerName: string, descriptor: string | undefined): SpeakerRole {
  const value = `${speakerName} ${descriptor ?? ""}`;
  if (/\boperator\b/iu.test(value)) return "operator";
  if (/\b(?:investor relations?|ir officer)\b/iu.test(value)) return "investor_relations";
  if (/\b(?:analyst|research|securities|capital markets)\b/iu.test(value)) return "analyst";
  if (/\b(?:chief|ceo|cfo|coo|president|vice president|executive|officer|chair)\b/iu.test(value)) {
    return "executive";
  }
  return "unknown";
}

function createTranscriptTurn(input: {
  readonly end: number;
  readonly role: SpeakerRole;
  readonly sectionId: string;
  readonly speakerName: string;
  readonly start: number;
  readonly text: string;
}) {
  return Object.freeze({
    end: input.end,
    role: input.role,
    sectionId: input.sectionId,
    speakerName: input.speakerName,
    start: input.start,
    turnDigest: digestEarningsCallValue(input.text.slice(input.start, input.end)),
    turnId: `turn.${digestEarningsCallValue([
      input.sectionId,
      input.start,
      input.end,
    ]).slice(0, 32)}`,
  });
}

function findSpeakerTurns(input: {
  readonly sectionEnd: number;
  readonly sectionId: string;
  readonly sectionStart: number;
  readonly text: string;
}) {
  const turns: EarningsTranscript["speakerTurns"] = [];
  const sectionText = input.text.slice(input.sectionStart, input.sectionEnd);
  let relativeCursor = 0;
  for (const line of sectionText.split("\n")) {
    const start = input.sectionStart + relativeCursor;
    const end = start + line.length;
    relativeCursor += line.length + 1;
    const matched = /^(.{1,120}?)(?:\s+\(([^()]{2,100})\)|\s+[—-]\s+([^:]{2,100}))?:\s+(.+)$/u.exec(line);
    if (!matched || matched[1]!.trim().length === 0) continue;
    const speakerName = matched[1]!.trim();
    const role = speakerRole(speakerName, matched[2] ?? matched[3]);
    turns.push(createTranscriptTurn({
      end,
      role,
      sectionId: input.sectionId,
      speakerName,
      start,
      text: input.text,
    }));
  }
  return Object.freeze(turns);
}

function qaPairs(turns: EarningsTranscript["speakerTurns"]) {
  const pairs: EarningsTranscript["qaPairs"] = [];
  let questionTurnIds: string[] = [];
  let answerTurnIds: string[] = [];
  const flush = () => {
    if (questionTurnIds.length > 0 && answerTurnIds.length > 0) {
      pairs.push({
        answerTurnIds: answerTurnIds.slice(0, 8),
        pairId: `qa.${digestEarningsCallValue([questionTurnIds, answerTurnIds]).slice(0, 32)}`,
        questionTurnIds: questionTurnIds.slice(0, 4),
      });
    }
    questionTurnIds = [];
    answerTurnIds = [];
  };
  for (const turn of turns) {
    if (turn.role === "analyst") {
      if (answerTurnIds.length > 0) flush();
      questionTurnIds.push(turn.turnId);
    } else if (turn.role === "executive" && questionTurnIds.length > 0) {
      answerTurnIds.push(turn.turnId);
    }
  }
  flush();
  return Object.freeze(pairs);
}

function omissionNotice(text: string): string | null {
  const line = text.split("\n").find((candidate) =>
    /\b(?:edited|omitted|abridged|excerpted|not a complete transcript)\b/iu.test(candidate));
  return line ? line.slice(0, 500) : null;
}

function createTranscriptSections(input: {
  readonly eventRevisionId: string;
  readonly sections: readonly Readonly<{
    end: number;
    sectionKind: TranscriptSectionKind;
    start: number;
  }>[];
  readonly text: string;
}) {
  return input.sections.map((section) => {
    const sectionId = `section.${digestEarningsCallValue([
      input.eventRevisionId,
      section.sectionKind,
      section.start,
      section.end,
    ]).slice(0, 32)}`;
    return Object.freeze({
      characterCount: section.end - section.start,
      end: section.end,
      sectionDigest: digestEarningsCallValue(input.text.slice(section.start, section.end)),
      sectionId,
      sectionKind: section.sectionKind,
      start: section.start,
    });
  });
}

function buildTranscript(input: {
  readonly artifactDigest: string;
  readonly eventRevisionId: string;
  readonly prepared: Readonly<{ end: number; start: number }>;
  readonly qa: Readonly<{ end: number; start: number }>;
  readonly text: string;
}): EarningsTranscript {
  const sections = createTranscriptSections({
    eventRevisionId: input.eventRevisionId,
    sections: [
      { ...input.prepared, sectionKind: "prepared_remarks" },
      { ...input.qa, sectionKind: "questions_and_answers" },
    ],
    text: input.text,
  });
  const turns = sections.flatMap((section) => findSpeakerTurns({
    sectionEnd: section.end,
    sectionId: section.sectionId,
    sectionStart: section.start,
    text: input.text,
  }));
  const qaSectionId = sections.find(({ sectionKind }) =>
    sectionKind === "questions_and_answers")!.sectionId;
  const pairs = qaPairs(turns.filter(({ sectionId }) => sectionId === qaSectionId));
  if (pairs.length === 0) throw new Error("missing_qa");
  const transcriptId = `transcript.${digestEarningsCallValue([
    input.eventRevisionId,
    input.artifactDigest,
    EARNINGS_CALL_TRANSCRIPT_PARSER_VERSION,
  ]).slice(0, 40)}`;
  return earningsTranscriptSchema.parse({
    artifactDigest: input.artifactDigest,
    characterCount: input.text.length,
    coverage: {
      liveCallCompleteness: /\bcomplete and (?:unedited|verbatim) transcript\b/iu.test(input.text)
        ? "attested_complete"
        : "not_attested",
      omissionNotice: omissionNotice(input.text),
      preparedRemarks: "document_complete",
      questionsAndAnswers: "document_complete",
    },
    eventRevisionId: input.eventRevisionId,
    normalizedTextDigest: digestEarningsCallValue(input.text),
    parserVersion: EARNINGS_CALL_TRANSCRIPT_PARSER_VERSION,
    qaPairs: pairs,
    recordType: "earnings_call_transcript",
    schemaVersion: EARNINGS_CALL_SCHEMA_VERSION,
    sections,
    speakerTurns: turns,
    transcriptId,
  });
}

async function sourceText(input: {
  readonly artifactBytes: Uint8Array;
  readonly artifactMediaType: "application/pdf" | "text/html";
}): Promise<string> {
  if (input.artifactMediaType === "text/html") {
    try {
      return htmlToText(new TextDecoder("utf-8", { fatal: true }).decode(input.artifactBytes));
    } catch {
      return "";
    }
  }
  try {
    const projection = await projectHybridEvidencePdf(input.artifactBytes);
    return normalizeLineText(projection.pages.map(({ text }) => text).join("\n\n"));
  } catch {
    return "";
  }
}

export async function normalizeEarningsCallTranscript(input: {
  readonly artifactBytes: Uint8Array;
  readonly artifactDigest: string;
  readonly artifactMediaType: "application/pdf" | "text/html";
  readonly eventRevisionId: string;
  readonly fiscalPeriod: string;
}): Promise<EarningsCallTranscriptNormalizationOutcome> {
  if (input.artifactBytes.byteLength > EARNINGS_CALL_LIMITS.maximumArtifactBytes) {
    return Object.freeze({ reason: "artifact_oversized", state: "quarantined" });
  }
  if (createHash("sha256").update(input.artifactBytes).digest("hex") !== input.artifactDigest) {
    throw new Error("artifact_digest_mismatch");
  }
  const text = await sourceText(input);
  if (hostileInstructionDetected(text)) {
    return Object.freeze({ reason: "source_instruction_ignored", state: "quarantined" });
  }
  if (text.length > EARNINGS_CALL_LIMITS.maximumTranscriptCharacters) {
    return Object.freeze({ reason: "artifact_oversized", state: "quarantined" });
  }
  const {
    changedPrepared,
    changedQa,
    prepared: preparedHeading,
    qa: qaHeading,
  } = findTranscriptHeadings(text);
  if (!preparedHeading && !qaHeading && changedPrepared && changedQa) {
    return Object.freeze({
      artifactDigest: input.artifactDigest,
      reason: "registered_layout_changed",
      sourceText: text,
      state: "recovery_required",
    });
  }
  if (!preparedHeading && !qaHeading) {
    if (
      /\b(?:earnings|conference)\b.{0,80}\btranscript\b/iu.test(text) &&
      /\bquestions?\s+(?:and|&)\s+answers?\b/iu.test(text) &&
      transcriptPeriod(text) !== input.fiscalPeriod
    ) return Object.freeze({ reason: "ambiguous_period", state: "quarantined" });
    if (/\bprepared remarks?\b/iu.test(text)) {
      return Object.freeze({ reason: "missing_qa", state: "coverage_unavailable" });
    }
    return Object.freeze({ reason: "release_only", state: "coverage_unavailable" });
  }
  if (!qaHeading || !preparedHeading || qaHeading.start <= preparedHeading.end) {
    return Object.freeze({ reason: "missing_qa", state: "coverage_unavailable" });
  }
  if (transcriptPeriod(text) !== input.fiscalPeriod) {
    return Object.freeze({ reason: "ambiguous_period", state: "quarantined" });
  }
  if (text.length === 0) {
    return Object.freeze({ reason: "artifact_oversized", state: "quarantined" });
  }
  const preparedStart = text[preparedHeading.end] === "\n"
    ? preparedHeading.end + 1
    : preparedHeading.end;
  const qaStart = text[qaHeading.end] === "\n" ? qaHeading.end + 1 : qaHeading.end;
  try {
    const transcript = buildTranscript({
      artifactDigest: input.artifactDigest,
      eventRevisionId: input.eventRevisionId,
      prepared: { end: qaHeading.start, start: preparedStart },
      qa: { end: text.length, start: qaStart },
      text,
    });
    return Object.freeze({
      artifactDigest: input.artifactDigest,
      normalizedText: text,
      state: "accepted",
      transcript,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "missing_qa") {
      return Object.freeze({ reason: "missing_qa", state: "coverage_unavailable" });
    }
    throw error;
  }
}

const recoveryCandidateSchema = z.object({
  qaPairs: z.array(z.object({
    answerTurnIndexes: z.array(z.number().int().nonnegative()).min(1).max(8),
    questionTurnIndexes: z.array(z.number().int().nonnegative()).min(1).max(4),
  }).strict()).min(1).max(EARNINGS_CALL_LIMITS.maximumQaPairs),
  sections: z.array(z.object({
    end: z.number().int().positive(),
    sectionKind: z.enum(["prepared_remarks", "questions_and_answers"]),
    start: z.number().int().nonnegative(),
  }).strict()).length(2),
  speakerTurns: z.array(z.object({
    end: z.number().int().positive(),
    role: z.enum(["analyst", "executive", "investor_relations", "operator", "unknown"]),
    speakerName: z.string().trim().min(1).max(120),
    start: z.number().int().nonnegative(),
  }).strict()).min(1).max(EARNINGS_CALL_LIMITS.maximumSpeakerTurns),
}).strict();

export function validateEarningsCallTranscriptRecoveryCandidate(input: {
  readonly artifactDigest: string;
  readonly candidate: unknown;
  readonly eventRevisionId: string;
  readonly sourceText: string;
}): EarningsTranscript {
  if (
    input.sourceText.length === 0 ||
    input.sourceText.length > EARNINGS_CALL_LIMITS.maximumTranscriptCharacters ||
    hostileInstructionDetected(input.sourceText)
  ) throw new Error("recovered_evidence_invalid");
  const candidate = recoveryCandidateSchema.parse(input.candidate);
  const [prepared, qa] = candidate.sections;
  if (
    prepared?.sectionKind !== "prepared_remarks" ||
    qa?.sectionKind !== "questions_and_answers" ||
    prepared.start >= prepared.end || qa.start >= qa.end ||
    prepared.end !== qa.start || qa.end > input.sourceText.length ||
    !CHANGED_PREPARED_HEADING.test(input.sourceText.slice(prepared.start, prepared.end).split("\n", 1)[0]!) ||
    !CHANGED_QA_HEADING.test(input.sourceText.slice(qa.start, qa.end).split("\n", 1)[0]!)
  ) throw new Error("recovered_boundary_invalid");

  const sections = createTranscriptSections({
    eventRevisionId: input.eventRevisionId,
    sections: [prepared, qa],
    text: input.sourceText,
  });
  const turns = candidate.speakerTurns.map((turn) => {
    const section = sections.find((candidateSection) =>
      turn.start >= candidateSection.start && turn.end <= candidateSection.end);
    const exact = input.sourceText.slice(turn.start, turn.end);
    if (!section || turn.start >= turn.end || !exact.startsWith(turn.speakerName)) {
      throw new Error("recovered_span_invalid");
    }
    return createTranscriptTurn({
      end: turn.end,
      role: turn.role,
      sectionId: section.sectionId,
      speakerName: turn.speakerName,
      start: turn.start,
      text: input.sourceText,
    });
  });
  const pairs = candidate.qaPairs.map((pair) => {
    const questionTurns = pair.questionTurnIndexes.map((index) => turns[index]);
    const answerTurns = pair.answerTurnIndexes.map((index) => turns[index]);
    if (
      questionTurns.some((turn) => !turn || turn.role !== "analyst") ||
      answerTurns.some((turn) => !turn || turn.role !== "executive") ||
      [...questionTurns, ...answerTurns].some((turn) =>
        turn!.sectionId !== sections[1]!.sectionId)
    ) throw new Error("recovered_qa_invalid");
    const questionTurnIds = questionTurns.map((turn) => turn!.turnId);
    const answerTurnIds = answerTurns.map((turn) => turn!.turnId);
    return Object.freeze({
      answerTurnIds,
      pairId: `qa.${digestEarningsCallValue([questionTurnIds, answerTurnIds]).slice(0, 32)}`,
      questionTurnIds,
    });
  });
  const transcriptId = `transcript.${digestEarningsCallValue([
    input.eventRevisionId,
    input.artifactDigest,
    EARNINGS_CALL_TRANSCRIPT_PARSER_VERSION,
    "recovered",
  ]).slice(0, 40)}`;
  return earningsTranscriptSchema.parse({
    artifactDigest: input.artifactDigest,
    characterCount: input.sourceText.length,
    coverage: {
      liveCallCompleteness: "not_attested",
      omissionNotice: omissionNotice(input.sourceText),
      preparedRemarks: "document_complete",
      questionsAndAnswers: "document_complete",
    },
    eventRevisionId: input.eventRevisionId,
    normalizedTextDigest: digestEarningsCallValue(input.sourceText),
    parserVersion: EARNINGS_CALL_TRANSCRIPT_PARSER_VERSION,
    qaPairs: pairs,
    recordType: "earnings_call_transcript",
    schemaVersion: EARNINGS_CALL_SCHEMA_VERSION,
    sections,
    speakerTurns: turns,
    transcriptId,
  });
}

export function createEarningsCallCitation(input: {
  readonly artifactDigest: string;
  readonly end: number;
  readonly eventRevisionId: string;
  readonly normalizedText: string;
  readonly sectionId: string;
  readonly start: number;
  readonly transcript: EarningsTranscript;
}) {
  return createEarningsCallCitations({
    artifactDigest: input.artifactDigest,
    eventRevisionId: input.eventRevisionId,
    normalizedText: input.normalizedText,
    spans: [{ end: input.end, sectionId: input.sectionId, start: input.start }],
    transcript: input.transcript,
  })[0]!;
}

export function createEarningsCallCitations(input: {
  readonly artifactDigest: string;
  readonly eventRevisionId: string;
  readonly normalizedText: string;
  readonly spans: readonly Readonly<{ end: number; sectionId: string; start: number }>[];
  readonly transcript: EarningsTranscript;
}) {
  const sections = new Map(input.transcript.sections.map((section) => [section.sectionId, section]));
  if (
    input.artifactDigest !== input.transcript.artifactDigest ||
    input.eventRevisionId !== input.transcript.eventRevisionId ||
    input.normalizedText.length !== input.transcript.characterCount ||
    digestEarningsCallValue(input.normalizedText) !== input.transcript.normalizedTextDigest
  ) throw new Error("citation_invalid");
  return Object.freeze(input.spans.map((span) => {
    const section = sections.get(span.sectionId);
    if (!section || span.start < section.start || span.end > section.end || span.start >= span.end) {
      throw new Error("citation_invalid");
    }
    return earningsCitationSchema.parse({
      artifactDigest: input.artifactDigest,
      end: span.end,
      eventRevisionId: input.eventRevisionId,
      sectionId: span.sectionId,
      spanDigest: digestEarningsCallValue(input.normalizedText.slice(span.start, span.end)),
      start: span.start,
      transcriptId: input.transcript.transcriptId,
    });
  }));
}

function estimateTokens(characterCount: number): number {
  return Math.ceil(characterCount / 4);
}

export type EarningsCallEvidenceJobPlan = Readonly<{
  aggregateInputTokens: number;
  documentCoverage: "complete";
  jobs: readonly Readonly<{
    inputTokens: number;
    jobIndex: number;
    spans: readonly Readonly<{
      end: number;
      sectionId: string;
      sectionKind: TranscriptSectionKind;
      start: number;
    }>[];
  }>[];
  state: "overflow" | "sectioned" | "single_job";
  synthesisInputTokens: number;
}>;

export function planEarningsCallEvidenceJobs(input: {
  readonly normalizedText: string;
  readonly transcript: EarningsTranscript;
}): EarningsCallEvidenceJobPlan {
  if (
    input.normalizedText.length !== input.transcript.characterCount ||
    digestEarningsCallValue(input.normalizedText) !== input.transcript.normalizedTextDigest
  ) throw new Error("transcript_text_mismatch");
  const required = input.transcript.sections.filter(({ sectionKind }) =>
    sectionKind === "prepared_remarks" || sectionKind === "questions_and_answers");
  const totalCharacters = required.reduce((total, section) => total + section.characterCount, 0);
  const totalTokens = estimateTokens(totalCharacters);
  const limits = EARNINGS_CALL_POLICY.semanticEnvelope;
  if (totalTokens <= limits.maximumSingleJobInputTokens) {
    return Object.freeze({
      aggregateInputTokens: totalTokens,
      documentCoverage: "complete",
      jobs: Object.freeze([Object.freeze({
        inputTokens: totalTokens,
        jobIndex: 0,
        spans: Object.freeze(required.map((section) => Object.freeze({
          end: section.end,
          sectionId: section.sectionId,
          sectionKind: section.sectionKind as TranscriptSectionKind,
          start: section.start,
        }))),
      })]),
      state: "single_job",
      synthesisInputTokens: 0,
    });
  }
  const maximumChunkCharacters = limits.maximumSectionInputTokens * 4;
  const spans = required.flatMap((section) => {
    const chunks = [];
    for (let start = section.start; start < section.end; start += maximumChunkCharacters) {
      chunks.push(Object.freeze({
        end: Math.min(section.end, start + maximumChunkCharacters),
        sectionId: section.sectionId,
        sectionKind: section.sectionKind as TranscriptSectionKind,
        start,
      }));
    }
    return chunks;
  });
  const synthesisInputTokens = spans.length * limits.maximumSectionOutputTokens;
  const aggregateInputTokens = totalTokens + synthesisInputTokens;
  if (
    spans.length > limits.maximumSectionJobs ||
    synthesisInputTokens > limits.maximumSynthesisInputTokens ||
    aggregateInputTokens > limits.maximumAggregateInputTokens
  ) {
    return Object.freeze({
      aggregateInputTokens,
      documentCoverage: "complete",
      jobs: Object.freeze([]),
      state: "overflow",
      synthesisInputTokens,
    });
  }
  return Object.freeze({
    aggregateInputTokens,
    documentCoverage: "complete",
    jobs: Object.freeze(spans.map((span, jobIndex) => Object.freeze({
      inputTokens: estimateTokens(span.end - span.start),
      jobIndex,
      spans: Object.freeze([span]),
    }))),
    state: "sectioned",
    synthesisInputTokens,
  });
}
