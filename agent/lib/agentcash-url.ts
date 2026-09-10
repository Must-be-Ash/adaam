import { isIP } from "node:net";

import { isPublicNetworkAddress } from "#public-network-address";

export function isAgentcashPublicAddress(address: string): boolean {
  return isPublicNetworkAddress(address) &&
    (isIP(address) !== 6 || /^[23]/u.test(address));
}

export function isAgentcashPublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
    return url.protocol === "https:" &&
      !url.username && !url.password && !url.port && !url.hash &&
      (isIP(hostname)
        ? isAgentcashPublicAddress(hostname)
        : hostname.includes(".") &&
          !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(hostname));
  } catch {
    return false;
  }
}
