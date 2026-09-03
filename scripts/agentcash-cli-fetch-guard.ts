import { guardAgentcashProviderFetch } from "../agent/lib/agentcash-fetch-guard";

globalThis.fetch = guardAgentcashProviderFetch(
  globalThis.fetch,
  process.env.EVE_AGENTCASH_ALLOWED_ORIGINS,
);
