export const PUBLIC_COMMENTARY_MISSING_PRODUCTION_SEAMS = [
  "x_source_adapter",
  "revocable_evidence_store",
  "commentary_extraction_definition",
  "commentary_interpretation_definition",
  "web_corroboration_provider",
  "inverse_cramer_pack_runtime",
] as const;

export type PublicCommentaryMissingProductionSeam =
  typeof PUBLIC_COMMENTARY_MISSING_PRODUCTION_SEAMS[number];

export class PublicCommentaryMissingProductionSeamError extends Error {
  readonly seam: PublicCommentaryMissingProductionSeam;

  constructor(seam: PublicCommentaryMissingProductionSeam) {
    super(`public_commentary_missing_production_seam:${seam}`);
    this.name = "PublicCommentaryMissingProductionSeamError";
    this.seam = seam;
  }
}

export function assertPublicCommentaryProductionSeams(
  registered: Readonly<Partial<Record<PublicCommentaryMissingProductionSeam, true>>> = {},
): void {
  for (const seam of PUBLIC_COMMENTARY_MISSING_PRODUCTION_SEAMS) {
    if (!registered[seam]) throw new PublicCommentaryMissingProductionSeamError(seam);
  }
}
