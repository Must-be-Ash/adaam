export interface WorkspaceRuntimeFlags {
  readonly state: boolean;
  readonly monitorWrites: boolean;
  readonly dispatch: boolean;
  readonly paidResearch: boolean;
  readonly photonAlerts: boolean;
  readonly sourceEvents: boolean;
  readonly legacyTriggerCreation: boolean;
}

export class WorkspaceRuntimeFlagError extends Error {
  readonly code: "legacy_trigger_creation_disabled" | "workspace_monitor_writes_disabled";

  constructor(code: WorkspaceRuntimeFlagError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceRuntimeFlagError";
  }
}

function enabled(value: string | undefined): boolean {
  return value === "1";
}

export function requireLegacyTriggerCreation(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (!resolveWorkspaceRuntimeFlags(environment).legacyTriggerCreation) {
    throw new WorkspaceRuntimeFlagError("legacy_trigger_creation_disabled");
  }
}

export function requireWorkspaceMonitorWrites(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (!resolveWorkspaceRuntimeFlags(environment).monitorWrites) {
    throw new WorkspaceRuntimeFlagError("workspace_monitor_writes_disabled");
  }
}

function legacyCreationEnabled(value: string | undefined): boolean {
  return value !== "0";
}

export function resolveWorkspaceRuntimeFlags(
  environment: NodeJS.ProcessEnv = process.env,
): WorkspaceRuntimeFlags {
  const state = enabled(environment.EVE_WORKSPACE_STATE_ENABLED);
  const monitorWrites =
    state && enabled(environment.EVE_WORKSPACE_MONITOR_WRITES_ENABLED);

  return Object.freeze({
    state,
    monitorWrites,
    dispatch: state && enabled(environment.EVE_WORKSPACE_DISPATCH_ENABLED),
    paidResearch:
      state &&
      enabled(environment.EVE_WORKSPACE_DISPATCH_ENABLED) &&
      enabled(environment.EVE_WORKSPACE_PAID_RESEARCH_ENABLED),
    photonAlerts:
      state && enabled(environment.EVE_PHOTON_WORKSPACE_ALERTS_ENABLED),
    sourceEvents:
      state && enabled(environment.EVE_WORKSPACE_SOURCE_EVENTS_ENABLED),
    legacyTriggerCreation:
      !monitorWrites &&
      legacyCreationEnabled(environment.EVE_LEGACY_TRIGGER_CREATION_ENABLED),
  });
}
