import type { HybridEvidenceWorkerControlClients } from "./hybrid-evidence-worker";

const FIXTURE_CLIENTS = Symbol.for("adaam.hybrid-evidence-worker.fixture-clients.v1");
const FIXTURE_RPC_URL = "EVE_HYBRID_EVIDENCE_WORKER_FIXTURE_RPC_URL";
const FIXTURE_RPC_TOKEN = "EVE_HYBRID_EVIDENCE_WORKER_FIXTURE_RPC_TOKEN";

type FixtureGlobal = typeof globalThis & {
  [FIXTURE_CLIENTS]?: HybridEvidenceWorkerControlClients;
};

function fixtureRuntimeAllowed(): boolean {
  return process.env.NODE_ENV === "test" &&
    process.env.VERCEL === undefined &&
    process.env.VERCEL_ENV === undefined;
}

export function installHybridEvidenceWorkerFixtureClients(
  clients: HybridEvidenceWorkerControlClients,
): () => void {
  if (!fixtureRuntimeAllowed()) throw new Error("hybrid_worker_fixture_clients_denied");
  const target = globalThis as FixtureGlobal;
  if (target[FIXTURE_CLIENTS]) throw new Error("hybrid_worker_fixture_clients_already_installed");
  target[FIXTURE_CLIENTS] = clients;
  return () => {
    if (target[FIXTURE_CLIENTS] === clients) delete target[FIXTURE_CLIENTS];
  };
}

export function resolveHybridEvidenceWorkerFixtureClients():
  | HybridEvidenceWorkerControlClients
  | undefined {
  if (!fixtureRuntimeAllowed()) return undefined;
  const local = (globalThis as FixtureGlobal)[FIXTURE_CLIENTS];
  if (local) return local;
  const url = process.env[FIXTURE_RPC_URL];
  const token = process.env[FIXTURE_RPC_TOKEN];
  if (!url || !token) return undefined;
  const invoke = async (namespace: "artifacts" | "jobs", method: string, args: readonly unknown[]) => {
    const response = await fetch(url, {
      body: JSON.stringify({ args, method, namespace }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error(`hybrid_worker_fixture_rpc_${response.status}`);
    return (await response.json() as { result: unknown }).result;
  };
  const client = (namespace: "artifacts" | "jobs") => new Proxy({}, {
    get: (_target, property) => typeof property === "string"
      ? (...args: unknown[]) => invoke(namespace, property, args)
      : undefined,
  });
  return {
    artifacts: client("artifacts") as HybridEvidenceWorkerControlClients["artifacts"],
    jobs: client("jobs") as HybridEvidenceWorkerControlClients["jobs"],
  };
}
