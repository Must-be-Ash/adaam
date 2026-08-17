import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type {
  EarningsCallPublicSourceRequest,
  EarningsCallPublicSourceResponse,
} from "./earnings-call-public-source-adapter";
import { isReviewedEarningsCallRequestUrl } from "./earnings-call-public-source-contract";

type FetchImplementation = typeof fetch;
type ResolveAddresses = (hostname: string) => Promise<readonly string[]>;

export class EarningsCallSourceTransportError extends Error {
  constructor(readonly code:
    | "transport_address_forbidden"
    | "transport_origin_forbidden"
    | "transport_redirect_forbidden"
  ) {
    super(code);
    this.name = "EarningsCallSourceTransportError";
  }
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
}

function inV4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

export function isPublicEarningsCallAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, "");
  const mappedDotted = /^::ffff:(?<ipv4>\d{1,3}(?:\.\d{1,3}){3})$/u.exec(normalized)?.groups?.ipv4;
  const mappedHex = /^::ffff:(?<high>[0-9a-f]{1,4}):(?<low>[0-9a-f]{1,4})$/u.exec(normalized)?.groups;
  const ipv4 = mappedHex
    ? ((Number.parseInt(mappedHex.high!, 16) << 16) + Number.parseInt(mappedHex.low!, 16)) >>> 0
    : ipv4Number(mappedDotted ?? normalized);
  if (ipv4 !== null) {
    const forbidden: ReadonlyArray<readonly [string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
      ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
      ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
      ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !forbidden.some(([base, prefix]) => inV4Range(ipv4, ipv4Number(base)!, prefix));
  }
  if (isIP(normalized) !== 6) return false;
  return normalized !== "::" && normalized !== "::1" &&
    !/^f[cd]/u.test(normalized) &&
    !/^fe[89ab]/u.test(normalized) &&
    !/^fe[c-f]/u.test(normalized) &&
    !/^ff/u.test(normalized) &&
    !/^2001:db8(?::|$)/u.test(normalized);
}

async function defaultResolveAddresses(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
}

async function assertTrustedTarget(input: {
  readonly kind: EarningsCallPublicSourceRequest["kind"];
  readonly resolveAddresses: ResolveAddresses;
  readonly url: string;
}): Promise<void> {
  if (!isReviewedEarningsCallRequestUrl({ kind: input.kind, url: input.url })) {
    throw new EarningsCallSourceTransportError("transport_origin_forbidden");
  }
  const hostname = new URL(input.url).hostname.replace(/^\[|\]$/gu, "");
  const addresses = isIP(hostname) ? [hostname] : await input.resolveAddresses(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicEarningsCallAddress(address))) {
    throw new EarningsCallSourceTransportError("transport_address_forbidden");
  }
}

async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<{ readonly body: Uint8Array; readonly truncated: boolean }> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { body: new Uint8Array(), truncated: true };
  }
  if (!response.body) return { body: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > maximumBytes) {
      await reader.cancel();
      return { body: new Uint8Array(), truncated: true };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, truncated: false };
}

export function createEarningsCallPublicSourceFetch(options: {
  readonly fetch?: FetchImplementation;
  readonly now?: () => Date;
  readonly resolveAddresses?: ResolveAddresses;
} = {}): (request: EarningsCallPublicSourceRequest) => Promise<EarningsCallPublicSourceResponse> {
  const fetchImplementation = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const resolveAddresses = options.resolveAddresses ?? defaultResolveAddresses;
  return async (request) => {
    let url = request.url;
    const redirectChain: string[] = [];
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      await assertTrustedTarget({ kind: request.kind, resolveAddresses, url });
      redirectChain.push(url);
      const response = await fetchImplementation(url, {
        headers: request.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === 3) {
          throw new EarningsCallSourceTransportError("transport_redirect_forbidden");
        }
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          throw new EarningsCallSourceTransportError("transport_redirect_forbidden");
        }
        await assertTrustedTarget({ kind: request.kind, resolveAddresses, url: next });
        url = next;
        continue;
      }
      const { body, truncated } = await readBoundedResponseBody(response, request.maximumBytes);
      return Object.freeze({
        body,
        contentType: response.headers.get("content-type") ?? "",
        finalUrl: url,
        observedAt: now().toISOString(),
        redirectChain: Object.freeze(redirectChain),
        redirectCount,
        requestedUrl: request.url,
        status: response.status,
        truncated: truncated || undefined,
      });
    }
    throw new EarningsCallSourceTransportError("transport_redirect_forbidden");
  };
}
