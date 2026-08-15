import {
  IPO_FILINGS_CAPABILITY_MANIFEST,
  SEC_IPO_SOURCE_ALLOWED_ORIGINS,
  SEC_IPO_SOURCE_CONTRACT_DIGEST,
  SEC_IPO_SOURCE_CONTRACT_VERSION,
  SEC_IPO_SOURCE_ID,
} from "./sec-ipo-reference";
import {
  readWorkspaceDocument,
  validateWorkspaceCapabilitySourceContract,
  WorkspaceStateConflictError,
  writeWorkspaceDocument,
  type WorkspaceDocument,
  type WorkspaceDocumentKind,
  type WorkspaceStateStoreClient,
} from "./workspace-state-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";

export class IpoFilingsWorkspaceRuntimeError extends Error {
  readonly code = "ipo_filings_workspace_runtime_conflict";

  constructor() {
    super("The workspace has an incompatible runtime configuration.");
    this.name = "IpoFilingsWorkspaceRuntimeError";
  }
}

async function createMissingDocument<K extends WorkspaceDocumentKind>(
  kind: K,
  input: {
    client?: WorkspaceStateStoreClient;
    now: Date;
    scope: AuthorizedWorkspaceStoreScope;
    value: WorkspaceDocument<K>["value"];
  },
): Promise<WorkspaceDocument<K>> {
  const current = await readWorkspaceDocument(kind, input.scope, input.client);
  if (current) return current;
  try {
    return await writeWorkspaceDocument(kind, {
      expectedRevision: 0,
      now: input.now,
      scope: input.scope,
      value: input.value as never,
    }, input.client);
  } catch (error) {
    if (!(error instanceof WorkspaceStateConflictError)) throw error;
    const raced = await readWorkspaceDocument(kind, input.scope, input.client);
    if (!raced) throw error;
    return raced;
  }
}

function supportsIpoReference(
  document: WorkspaceDocument<"capabilities">,
): boolean {
  const value = document.value;
  return (
    value.maximumDataAccessClassification === "public" &&
    value.paidResearchAllowed === false &&
    value.sources.some((source) => {
      try {
        validateWorkspaceCapabilitySourceContract(source, {
          allowedOrigins: SEC_IPO_SOURCE_ALLOWED_ORIGINS,
          contractDigest: SEC_IPO_SOURCE_CONTRACT_DIGEST,
          contractVersion: SEC_IPO_SOURCE_CONTRACT_VERSION,
          sourceId: SEC_IPO_SOURCE_ID,
        });
        return source.origin === "https://www.sec.gov";
      } catch {
        return false;
      }
    }) &&
    IPO_FILINGS_CAPABILITY_MANIFEST.controlPlaneToolIds.every((id) => value.controlPlaneToolIds.includes(id)) &&
    IPO_FILINGS_CAPABILITY_MANIFEST.researchToolIds.every((id) => value.researchToolIds.includes(id)) &&
    IPO_FILINGS_CAPABILITY_MANIFEST.workerModelPolicy.allowedModelIds.every((id) =>
      value.workerModelPolicy.allowedModelIds.includes(id)) &&
    value.skills.some((skill) => skill.id === "public-event-monitoring" && skill.version === "1.0.0")
  );
}

export async function ensureIpoFilingsWorkspaceRuntime(input: {
  client?: WorkspaceStateStoreClient;
  now?: Date;
  ownerTimezone: string;
  scope: AuthorizedWorkspaceStoreScope;
}): Promise<{
  brief: WorkspaceDocument<"brief">;
  budget: WorkspaceDocument<"budget">;
  capabilities: WorkspaceDocument<"capabilities">;
  strategy: WorkspaceDocument<"strategy">;
}> {
  const now = input.now ?? new Date();
  const brief = await createMissingDocument("brief", {
    client: input.client,
    now,
    scope: input.scope,
    value: {
      currentFindingsSummary: "No SEC IPO filing findings yet.",
      goal: "Track new SEC S-1 registrations and S-1/A updates from the official latest-filings feed.",
      lastMaterialChange: "IPO Filings reference runtime initialized.",
      openQuestions: [],
      promotedFacts: [],
      sourcePolicy: {
        allowedSourceIds: [SEC_IPO_SOURCE_ID],
        maximumAccessClassification: "public",
      },
      strategyConfigurationRevision: 1,
      thesis: "",
      watchlist: [],
    },
  });
  const strategy = await createMissingDocument("strategy", {
    client: input.client,
    now,
    scope: input.scope,
    value: { configuration: {}, strategyPack: null },
  });
  const capabilities = await createMissingDocument("capabilities", {
    client: input.client,
    now,
    scope: input.scope,
    value: IPO_FILINGS_CAPABILITY_MANIFEST,
  });
  const budget = await createMissingDocument("budget", {
    client: input.client,
    now,
    scope: input.scope,
    value: {
      effectiveAt: now.toISOString(),
      maximumConcurrentWorkers: 1,
      maximumInputTokensPerDay: 40_000,
      maximumInputTokensPerRun: 10_000,
      maximumOutputTokensPerDay: 8_000,
      maximumOutputTokensPerRun: 2_000,
      maximumPaidPerCall: null,
      maximumPaidPerDay: null,
      maximumPaidPerMonth: null,
      maximumScheduledRunsPerDay: 4,
      ownerTimezone: input.ownerTimezone,
      unknownPriceFallbackCeiling: "0",
    },
  });
  if (!supportsIpoReference(capabilities)) {
    throw new IpoFilingsWorkspaceRuntimeError();
  }
  return { brief, budget, capabilities, strategy };
}
