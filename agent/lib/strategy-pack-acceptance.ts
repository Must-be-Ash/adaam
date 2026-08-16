import {
  evaluateSecIpoPage,
  type SecIpoCheckpoint,
} from "./sec-ipo-evaluation";
import type { SecIpoAtomPage, SecIpoFiling } from "./sec-ipo-reference";

export class StrategyPackAcceptanceError extends Error {
  readonly code:
    | "acceptance_target_absent"
    | "acceptance_target_has_no_predecessor"
    | "acceptance_target_not_latest"
    | "acceptance_target_window_ambiguous";

  constructor(code: StrategyPackAcceptanceError["code"]) {
    super(code);
    this.code = code;
    this.name = "StrategyPackAcceptanceError";
  }
}

export function prepareSecIpoAcceptanceReplay(input: {
  identityScope: { ownerId: string; workspaceId: string };
  page: SecIpoAtomPage;
  targetAccessionNumber: string;
}): {
  checkpoint: SecIpoCheckpoint;
  predecessor: SecIpoFiling;
  target: SecIpoFiling;
} {
  const target = input.page.filings.find(
    ({ accessionNumber }) => accessionNumber === input.targetAccessionNumber,
  );
  if (!target) throw new StrategyPackAcceptanceError("acceptance_target_absent");
  if (input.page.filings.some(({ updatedAt }) => updatedAt > target.updatedAt)) {
    throw new StrategyPackAcceptanceError("acceptance_target_not_latest");
  }
  const predecessors = input.page.filings.filter(
    ({ updatedAt }) => updatedAt < target.updatedAt,
  );
  const predecessor = predecessors.reduce<SecIpoFiling | undefined>(
    (latest, filing) =>
      !latest || filing.updatedAt > latest.updatedAt ? filing : latest,
    undefined,
  );
  if (!predecessor) {
    throw new StrategyPackAcceptanceError(
      "acceptance_target_has_no_predecessor",
    );
  }
  if (
    input.page.filings.some(
      (filing) =>
        filing.accessionNumber !== target.accessionNumber &&
        filing.updatedAt === target.updatedAt,
    )
  ) {
    throw new StrategyPackAcceptanceError(
      "acceptance_target_window_ambiguous",
    );
  }
  const baseline = evaluateSecIpoPage(
    input.page,
    null,
    input.identityScope,
    { windowEndAt: predecessor.updatedAt },
  );
  return Object.freeze({
    checkpoint: baseline.checkpoint,
    predecessor,
    target,
  });
}
