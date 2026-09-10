import { isIP } from "node:net";

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce(
    (value, octet) => (value << 8) + Number(octet),
    0,
  ) >>> 0;
}

function inV4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

export function isPublicNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, "");
  const mappedDotted = /^::ffff:(?<ipv4>\d{1,3}(?:\.\d{1,3}){3})$/u
    .exec(normalized)?.groups?.ipv4;
  const mappedHex = /^::ffff:(?<high>[0-9a-f]{1,4}):(?<low>[0-9a-f]{1,4})$/u
    .exec(normalized)?.groups;
  const ipv4 = mappedHex
    ? ((Number.parseInt(mappedHex.high!, 16) << 16) +
      Number.parseInt(mappedHex.low!, 16)) >>> 0
    : ipv4Number(mappedDotted ?? normalized);
  if (ipv4 !== null) {
    const forbidden: ReadonlyArray<readonly [string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
      ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
      ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
      ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !forbidden.some(([base, prefix]) =>
      inV4Range(ipv4, ipv4Number(base)!, prefix)
    );
  }
  if (isIP(normalized) !== 6) return false;
  return normalized !== "::" && normalized !== "::1" &&
    !/^f[cd]/u.test(normalized) &&
    !/^fe[89ab]/u.test(normalized) &&
    !/^fe[c-f]/u.test(normalized) &&
    !/^ff/u.test(normalized) &&
    !/^2001:db8(?::|$)/u.test(normalized);
}

