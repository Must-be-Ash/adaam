import type { SecIpoWorkspaceWorkerClients } from "./sec-ipo-workspace-worker";

const FIXTURE_CLIENTS = Symbol.for(
  "adaam.workspace-worker.sec-ipo-fixture-clients.v1",
);

type FixtureGlobal = typeof globalThis & {
  [FIXTURE_CLIENTS]?: SecIpoWorkspaceWorkerClients;
};

const FIXTURE_RPC_URL = "EVE_WORKSPACE_WORKER_FIXTURE_RPC_URL";
const FIXTURE_RPC_TOKEN = "EVE_WORKSPACE_WORKER_FIXTURE_RPC_TOKEN";

function fixtureRuntimeAllowed(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.VERCEL === undefined &&
    process.env.VERCEL_ENV === undefined
  );
}

/**
 * Installs deterministic storage and fetch clients for a compiled-worker test.
 * The seam is unavailable in Vercel and outside NODE_ENV=test, and it never
 * replaces Eve's worker runtime or model selection.
 */
export function installSecIpoWorkspaceWorkerFixtureClients(
  clients: SecIpoWorkspaceWorkerClients,
): () => void {
  if (!fixtureRuntimeAllowed()) {
    throw new Error("workspace_worker_fixture_clients_denied");
  }
  const target = globalThis as FixtureGlobal;
  if (target[FIXTURE_CLIENTS] !== undefined) {
    throw new Error("workspace_worker_fixture_clients_already_installed");
  }
  target[FIXTURE_CLIENTS] = clients;
  return () => {
    if (target[FIXTURE_CLIENTS] === clients) {
      delete target[FIXTURE_CLIENTS];
    }
  };
}

export function resolveSecIpoWorkspaceWorkerFixtureClients():
  | SecIpoWorkspaceWorkerClients
  | undefined {
  if (!fixtureRuntimeAllowed()) return undefined;
  const local = (globalThis as FixtureGlobal)[FIXTURE_CLIENTS];
  if (local) return local;
  const url = process.env[FIXTURE_RPC_URL];
  const token = process.env[FIXTURE_RPC_TOKEN];
  if (!url || !token) return undefined;

  const invoke = async (
    namespace: keyof SecIpoWorkspaceWorkerClients,
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> => {
    const response = await fetch(url, {
      body: JSON.stringify({ args, method, namespace }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`workspace_worker_fixture_rpc_${response.status}`);
    }
    return (await response.json() as { result: unknown }).result;
  };
  const client = (namespace: keyof SecIpoWorkspaceWorkerClients) =>
    new Proxy({}, {
      get: (_target, property) => {
        if (typeof property !== "string") return undefined;
        return (...args: unknown[]) => invoke(namespace, property, args);
      },
    });
  return {
    alert: client("alert") as NonNullable<SecIpoWorkspaceWorkerClients["alert"]>,
    fetchSource: (requestedUrl) =>
      invoke("fetchSource", "fetchSource", [requestedUrl]) as ReturnType<
        NonNullable<SecIpoWorkspaceWorkerClients["fetchSource"]>
      >,
    finding: client("finding") as NonNullable<SecIpoWorkspaceWorkerClients["finding"]>,
    monitor: client("monitor") as NonNullable<SecIpoWorkspaceWorkerClients["monitor"]>,
    publishReport: (input) =>
      invoke("publishReport", "publishReport", [input]) as ReturnType<
        NonNullable<SecIpoWorkspaceWorkerClients["publishReport"]>
      >,
    sourceCoverage: client("sourceCoverage") as NonNullable<
      SecIpoWorkspaceWorkerClients["sourceCoverage"]
    >,
    state: client("state") as NonNullable<SecIpoWorkspaceWorkerClients["state"]>,
  };
}
