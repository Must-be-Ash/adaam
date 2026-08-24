import {
  createPublicCommentaryResearchDefinition,
  PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID,
  PUBLIC_COMMENTARY_RESEARCH_DEFINITION_VERSIONS,
} from "./public-commentary-research";
import {
  createInverseCramerResearchDefinition,
  INVERSE_CRAMER_RESEARCH_DEFINITION_ID,
  INVERSE_CRAMER_RESEARCH_DEFINITION_VERSIONS,
} from "./inverse-cramer-research";

/*
 * Which commentary strategies get a research lane is a property of what their
 * pack DECLARES, never of which pack they are. It used to be a literal
 * `packId !== "inverse-cramer"` check, so the Public Commentary Tracker could
 * not have research even if its pack declared a research contract - the
 * declaration was not the switch, the identity was. That is the pack-ID
 * behaviour branch the boundary migration exists to remove; pack IDs stay valid
 * as provenance, registry keys and binding identity, but never as a capability
 * gate.
 *
 * Research is also not a fact-checking pass. A strategy declares this lane when
 * a statement is a STARTING POINT that needs surrounding context before it
 * means anything - a macro or commodity read, say. A strategy whose statement
 * IS the conclusion (Inverse Cramer inverts a named view; a policy statement
 * about a conflict is itself the signal) declares no research lane and is
 * answered from the statement alone. Declaring nothing is a valid, cheap and
 * deliberate choice, not a gap.
 */

export interface PublicCommentaryResearchContract {
  readonly definitionId: string;
  readonly versions: readonly string[];
  createDefinition(
    modelIds: readonly string[],
    version: string,
  ): ReturnType<typeof createInverseCramerResearchDefinition>;
}

const contracts = new Map<string, PublicCommentaryResearchContract>([
  [INVERSE_CRAMER_RESEARCH_DEFINITION_ID, Object.freeze({
    createDefinition: (modelIds: readonly string[], version: string) =>
      createInverseCramerResearchDefinition(
        [...modelIds],
        version as (typeof INVERSE_CRAMER_RESEARCH_DEFINITION_VERSIONS)[number],
      ),
    definitionId: INVERSE_CRAMER_RESEARCH_DEFINITION_ID,
    versions: INVERSE_CRAMER_RESEARCH_DEFINITION_VERSIONS,
  })],
  [PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID, Object.freeze({
    createDefinition: (modelIds: readonly string[], version: string) =>
      createPublicCommentaryResearchDefinition(
        [...modelIds],
        version as (typeof PUBLIC_COMMENTARY_RESEARCH_DEFINITION_VERSIONS)[number],
      ),
    definitionId: PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID,
    versions: PUBLIC_COMMENTARY_RESEARCH_DEFINITION_VERSIONS,
  })],
]);

/**
 * The research contract a pack declares, or null when it declares none. A pack
 * declaring more than one is ambiguous and resolves to null rather than
 * guessing which lane the owner meant.
 */
export function resolvePublicCommentaryResearchContract(pack: Readonly<{
  evidenceContracts?: readonly Readonly<{ id: string; version: string }>[];
}>): Readonly<{ contract: PublicCommentaryResearchContract; version: string }> | null {
  const declared = (pack.evidenceContracts ?? []).flatMap(({ id, version }) => {
    const contract = contracts.get(id);
    return contract && contract.versions.includes(version)
      ? [Object.freeze({ contract, version })]
      : [];
  });
  return declared.length === 1 ? declared[0]! : null;
}
