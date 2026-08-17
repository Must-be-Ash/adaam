export const EARNINGS_CALL_MISSING_PRODUCTION_SEAMS = [
  "source_adapter",
  "transcript_parser",
  "comparison_evaluator",
  "semantic_definition",
  "pack_runtime",
] as const;

export type EarningsCallMissingProductionSeam =
  typeof EARNINGS_CALL_MISSING_PRODUCTION_SEAMS[number];

export class EarningsCallMissingProductionSeamError extends Error {
  readonly seam: EarningsCallMissingProductionSeam;

  constructor(seam: EarningsCallMissingProductionSeam) {
    super(`earnings_call_missing_production_seam:${seam}`);
    this.name = "EarningsCallMissingProductionSeamError";
    this.seam = seam;
  }
}

export function assertEarningsCallProductionSeams(
  registered: Readonly<Partial<Record<EarningsCallMissingProductionSeam, true>>> = {},
): void {
  for (const seam of EARNINGS_CALL_MISSING_PRODUCTION_SEAMS) {
    if (!registered[seam]) throw new EarningsCallMissingProductionSeamError(seam);
  }
}
