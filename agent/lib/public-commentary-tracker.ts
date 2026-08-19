import { marketSymbolSchema } from "./strategy-pack-schema";
import { parseConfirmedXPublicIdentity } from "./x-public-identity";

const SENSITIVE_EVENT_CONTEXT = /\b(?:gaza|iran|israel|russia|ukraine)\b/iu;
const DE_ESCALATION_TERMS = /\b(?:agreed to|ceasefire|de[- ]escalat(?:e|ion)|have a deal|negotiat(?:e|ion|ions)|peace)\b/iu;
const ESCALATION_TERMS = /\b(?:conflict|escalat(?:e|ion)|hostilit(?:y|ies)|maximum pressure|strike readiness|war|worsen(?:ing|ed)?)\b/iu;

export interface PublicCommentaryImpactHypothesis {
  readonly asset: string;
  readonly outcome: string;
  readonly pressure: "down" | "up";
}

export type PublicCommentaryImpactClassification = "de_escalation" | "escalation" | "mixed" | "unclear";

export function parsePublicCommentaryImpactHypotheses(values: unknown): readonly PublicCommentaryImpactHypothesis[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) {
    throw new Error("public_commentary_impact_hypotheses_invalid");
  }
  const parsed = values.map((value) => {
    if (typeof value !== "string") throw new Error("public_commentary_impact_hypotheses_invalid");
    const [outcome, assetValue, pressure, ...remainder] = value.split("|");
    const asset = marketSymbolSchema.safeParse(assetValue);
    if (
      remainder.length !== 0 || !outcome || outcome.trim() !== outcome ||
      !asset.success || (pressure !== "up" && pressure !== "down")
    ) throw new Error("public_commentary_impact_hypotheses_invalid");
    return Object.freeze({ asset: asset.data, outcome, pressure });
  });
  return Object.freeze(parsed);
}

function phraseMatch(normalizedText: string, phrase: string): boolean {
  const alternatives = phrase.split(/\s+(?:or|and)\s+|,/iu).map((value) => value.trim()).filter(Boolean);
  return alternatives.some((value) => {
    const normalized = value.toLocaleLowerCase("en-US");
    if (normalizedText.includes(normalized)) return true;
    if (normalized === "escalation" || normalized === "worsening conflict") {
      return ESCALATION_TERMS.test(normalizedText);
    }
    if (["de-escalation", "ceasefire", "peace"].includes(normalized)) {
      return DE_ESCALATION_TERMS.test(normalizedText);
    }
    return false;
  });
}

export function classifyPublicCommentaryImpact(
  text: string,
  hypotheses: readonly PublicCommentaryImpactHypothesis[],
  topics: readonly string[] = [],
): Readonly<{
  asset: string | null;
  classification: PublicCommentaryImpactClassification;
  pressure: "down" | "up" | null;
}> {
  const normalizedText = text.toLocaleLowerCase("en-US");
  const outcomeTerms = hypotheses.flatMap(({ outcome }) =>
    outcome.split(/\s+(?:or|and)\s+|,/iu).map((value) => value.trim().toLocaleLowerCase("en-US")));
  const entityTopics = topics.map((value) => value.trim().toLocaleLowerCase("en-US")).filter((value) =>
    value.length > 1 && !outcomeTerms.includes(value) &&
    !/^(?:ceasefire|conflict|de-escalation|escalation|hostilities|negotiations|peace|war)$/u.test(value));
  const relevant = topics.length === 0 ||
    (entityTopics.length ? entityTopics : topics.map((value) => value.toLocaleLowerCase("en-US")))
      .some((value) => normalizedText.includes(value));
  if (!relevant) return Object.freeze({ asset: null, classification: "unclear", pressure: null });
  const matches = hypotheses.filter(({ outcome }) => phraseMatch(normalizedText, outcome));
  const textEscalation = ESCALATION_TERMS.test(text);
  const textDeEscalation = DE_ESCALATION_TERMS.test(text);
  const directions = new Set(matches.map(({ pressure }) => pressure));
  if (directions.size > 1 || (textEscalation && textDeEscalation)) {
    return Object.freeze({ asset: null, classification: "mixed", pressure: null });
  }
  const inferredPressure = textEscalation ? "up" : textDeEscalation ? "down" : null;
  const match = matches.length === 1 ? matches[0]! : matches.find(({ pressure }) =>
    pressure === inferredPressure);
  if (!match) return Object.freeze({ asset: null, classification: "unclear", pressure: null });
  return Object.freeze({
    asset: match.asset,
    classification: match.pressure === "up" ? "escalation" : "de_escalation",
    pressure: match.pressure,
  });
}

export function resolvePublicCommentaryTrackerSourcePolicy(configuration: Readonly<Record<string, unknown>>) {
  let identity;
  try {
    identity = parseConfirmedXPublicIdentity(configuration.xIdentity);
  } catch {
    throw new Error("public_commentary_tracker_identity_unconfirmed");
  }
  const objective = typeof configuration.monitoringObjective === "string"
    ? configuration.monitoringObjective
    : "";
  const topics = Array.isArray(configuration.topics)
    ? configuration.topics.filter((value): value is string => typeof value === "string")
    : [];
  const hypotheses = Array.isArray(configuration.impactHypotheses)
    ? configuration.impactHypotheses.filter((value): value is string => typeof value === "string")
    : [];
  const policyText = [objective, ...topics, ...hypotheses].join(" ");
  const sensitiveEvent = SENSITIVE_EVENT_CONTEXT.test(policyText);
  if (sensitiveEvent) {
    const approvedTrumpIranPreset = identity.numericUserId === "25073877" &&
      configuration.trackerName === "Trump–Iran Oil Tracker" && /\biran\b/iu.test(policyText);
    if (!approvedTrumpIranPreset) {
      throw new Error("public_commentary_tracker_sensitive_source_unavailable");
    }
    return Object.freeze({
      numericUserId: null,
      reason: "X sensitive-event monitoring is restricted without written approval; use the approved first-party White House source.",
      sourceKind: "official_white_house" as const,
      xEnabled: false as const,
    });
  }
  return Object.freeze({
    numericUserId: identity.numericUserId,
    reason: "Configured public-statement research does not match the bounded sensitive-event gate.",
    sourceKind: "x_user_timeline" as const,
    xEnabled: true as const,
  });
}
