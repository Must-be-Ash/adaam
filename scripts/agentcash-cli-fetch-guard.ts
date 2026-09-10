import { guardAgentcashProviderFetch } from "../agent/lib/agentcash-fetch-guard";

globalThis.fetch = guardAgentcashProviderFetch(
  globalThis.fetch,
);
