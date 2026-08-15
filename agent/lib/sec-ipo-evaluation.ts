import { createHash } from "node:crypto";

import {
  normalizeSecIpoAtom,
  SEC_IPO_SOURCE_ID,
  SEC_IPO_SOURCE_URL,
  type SecIpoAtomPage,
  type SecIpoFiling,
} from "./sec-ipo-reference";
import {
  SEC_IPO_FACT_SCHEMA_VERSION,
  type SecIpoFilingFact,
} from "./workspace-finding-facts";

export interface SecIpoCheckpoint {
  readonly contentDigest: string;
  readonly watermark: string;
}

export interface SecIpoFindingCandidate {
  readonly fact: SecIpoFilingFact;
  readonly findingId: string;
  readonly filing: SecIpoFiling;
  readonly summary: string;
}

function typedFact(
  filing: SecIpoFiling,
  page: SecIpoAtomPage,
): SecIpoFilingFact {
  return Object.freeze({
    accessionNumber: filing.accessionNumber,
    amendmentIdentity:
      filing.classification === "amendment"
        ? `${filing.registrationKey}:${filing.dedupeKey}`
        : null,
    canonicalFilingUrl: filing.canonicalFilingUrl,
    cik: filing.cik,
    classification: filing.classification,
    companyName: filing.companyName,
    contentEvidence: Object.freeze({
      feedContentHash: page.contentHash,
      normalizedFilingHash: filing.contentHash,
    }),
    fileNumber: filing.fileNumber,
    filedAt: filing.publishedAt,
    filingIdentity: filing.dedupeKey,
    formType: filing.formType,
    kind: "sec_ipo_filing",
    normalizerVersion: filing.normalizerVersion,
    observedAt: filing.observedAt,
    registrationIdentity: filing.registrationKey,
    schemaVersion: SEC_IPO_FACT_SCHEMA_VERSION,
    source: Object.freeze({
      accessClassification: "public",
      canonicalUrl: SEC_IPO_SOURCE_URL,
      origin: new URL(SEC_IPO_SOURCE_URL).origin,
      sourceId: SEC_IPO_SOURCE_ID,
    }),
    updatedAt: filing.updatedAt,
  });
}

export interface SecIpoAlertCandidate {
  readonly alertId: string;
  readonly findingId: string;
  readonly title: string;
  readonly whyMatched: string;
}

export interface SecIpoEvaluation {
  readonly alerts: readonly SecIpoAlertCandidate[];
  readonly baselineEstablished: boolean;
  readonly checkpoint: SecIpoCheckpoint;
  readonly findings: readonly SecIpoFindingCandidate[];
}

export class SecIpoEvaluationError extends Error {
  readonly code:
    | "sec_atom_ambiguous_window"
    | "sec_atom_fetch_incomplete"
    | "sec_atom_redirected"
    | "sec_atom_stale";

  constructor(code: SecIpoEvaluationError["code"]) {
    super(code);
    this.code = code;
    this.name = "SecIpoEvaluationError";
  }
}

export function normalizeSecIpoFetch(input: {
  body: string;
  contentType: string;
  finalUrl: string;
  observedAt: string;
  requestedUrl: string;
  status: number;
  truncated?: boolean;
}): SecIpoAtomPage {
  if (
    input.requestedUrl !== SEC_IPO_SOURCE_URL ||
    input.finalUrl !== SEC_IPO_SOURCE_URL
  ) {
    throw new SecIpoEvaluationError("sec_atom_redirected");
  }
  if (
    input.status !== 200 ||
    input.truncated === true ||
    !/(?:application|text)\/(?:atom\+xml|xml)/iu.test(input.contentType)
  ) {
    throw new SecIpoEvaluationError("sec_atom_fetch_incomplete");
  }
  return normalizeSecIpoAtom(input.body, { observedAt: input.observedAt });
}

function digestId(
  kind: "alert" | "finding",
  filing: SecIpoFiling,
  identityScope: { ownerId: string; workspaceId: string },
): string {
  return `${kind}_${createHash("sha256")
    .update(
      `sec-ipo-${kind}\0${identityScope.ownerId}\0${identityScope.workspaceId}\0${filing.dedupeKey}`,
    )
    .digest("hex")}`;
}

function nextCheckpoint(page: SecIpoAtomPage): SecIpoCheckpoint {
  const latest = page.filings.reduce(
    (watermark, filing) => filing.updatedAt > watermark ? filing.updatedAt : watermark,
    "",
  );
  return Object.freeze({
    contentDigest: page.contentHash,
    watermark: latest || page.observedAt,
  });
}

export function evaluateSecIpoPage(
  page: SecIpoAtomPage,
  checkpoint: SecIpoCheckpoint | null,
  identityScope: { ownerId: string; workspaceId: string },
): SecIpoEvaluation {
  const next = nextCheckpoint(page);
  if (checkpoint === null) {
    return Object.freeze({
      alerts: Object.freeze([]),
      baselineEstablished: true,
      checkpoint: next,
      findings: Object.freeze([]),
    });
  }
  const latest = page.filings.at(-1)?.updatedAt ?? page.observedAt;
  if (latest < checkpoint.watermark) {
    throw new SecIpoEvaluationError("sec_atom_stale");
  }
  if (
    latest === checkpoint.watermark &&
    page.contentHash !== checkpoint.contentDigest
  ) {
    throw new SecIpoEvaluationError("sec_atom_ambiguous_window");
  }
  const newFilings = page.filings.filter(
    (filing) => filing.updatedAt > checkpoint.watermark,
  );
  const findings = Object.freeze(newFilings.map((filing) => Object.freeze({
    fact: typedFact(filing, page),
    findingId: digestId("finding", filing, identityScope),
    filing,
    summary: filing.classification === "new_registration"
      ? `${filing.companyName} filed Form S-1, a potential IPO registration; this does not prove an IPO will occur.`
      : `${filing.companyName} filed Form S-1/A, an update to registration ${filing.fileNumber ?? filing.accessionNumber}.`,
  })));
  const alerts = Object.freeze(findings.map((finding) => Object.freeze({
    alertId: digestId("alert", finding.filing, identityScope),
    findingId: finding.findingId,
    title: finding.filing.classification === "new_registration"
      ? "New SEC S-1 registration"
      : "SEC S-1 registration update",
    whyMatched: finding.filing.classification === "new_registration"
      ? "A newly observed S-1 is a potential IPO registration, not confirmation of an IPO."
      : "A newly observed S-1/A amends an existing registration and is not a new IPO candidate.",
  })));
  return Object.freeze({
    alerts,
    baselineEstablished: false,
    checkpoint: newFilings.length > 0 ? next : checkpoint,
    findings,
  });
}
