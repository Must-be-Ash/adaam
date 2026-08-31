import { z } from "zod";

export const CONGRESSIONAL_PACK_VERSIONS = [
  "1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0",
] as const;

export type CongressionalPackVersion = typeof CONGRESSIONAL_PACK_VERSIONS[number];

export const congressionalPackVersionSchema = z.enum(CONGRESSIONAL_PACK_VERSIONS);

export function isCongressionalPackVersion(version: string): version is CongressionalPackVersion {
  return CONGRESSIONAL_PACK_VERSIONS.some((candidate) => candidate === version);
}

export function congressionalPackSupportsHistory(version: CongressionalPackVersion): boolean {
  return version !== "1.0.0" && version !== "1.1.0";
}

export function congressionalPackSupportsResearch(version: CongressionalPackVersion): boolean {
  return version === "1.5.0" || version === "1.6.0";
}
