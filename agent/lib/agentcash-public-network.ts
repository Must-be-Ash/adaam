import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";

import { isAgentcashPublicAddress } from "#agentcash-url";

// Validate the DNS result used by the connection itself, preventing rebinding
// between a separate validation lookup and the actual network request.
export function createAgentcashPublicLookup(
  resolve: (hostname: string) => Promise<readonly { address: string; family: number }[]> =
    (hostname) => lookup(hostname, { all: true, verbatim: true }),
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then((addresses) => {
      const usable = addresses.filter(({ family }) => !options.family || family === options.family);
      if (!usable.length || addresses.some(({ address }) => !isAgentcashPublicAddress(address))) {
        callback(new Error("AgentCash requires a public network destination."), "", 4);
        return;
      }
      if (options.all) callback(null, [...usable]);
      else callback(null, usable[0]!.address, usable[0]!.family);
    }, () => callback(new Error("AgentCash destination could not be resolved."), "", 4));
  };
}

export const agentcashPublicDispatcher = new Agent({
  connect: { lookup: createAgentcashPublicLookup() },
});
