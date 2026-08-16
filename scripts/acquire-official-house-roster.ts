import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { XMLParser } from "fast-xml-parser";

const SOURCE_URL = "https://clerk.house.gov/xml/lists/MemberData.xml";
const OUTPUT_PATH = resolve(
  process.cwd(),
  "agent/catalogs/congressional-house-members/2026-07-06.json",
);
const MAXIMUM_SOURCE_BYTES = 1_000_000;

type XmlValue = Record<string, unknown>;

function record(value: unknown, code: string): XmlValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as XmlValue;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(code);
  return value.trim();
}

function sourceDate(value: string): string {
  const match = /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})$/u.exec(value);
  if (!match) throw new Error("house_roster_publish_date_invalid");
  const month = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ].indexOf(match[1]!) + 1;
  return `${match[3]}-${String(month).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
}

function compactDate(value: unknown): string {
  const date = text(record(value, "house_roster_sworn_date_invalid")["@date"], "house_roster_sworn_date_invalid");
  if (!/^\d{8}$/u.test(date)) throw new Error("house_roster_sworn_date_invalid");
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function party(value: unknown) {
  if (value === "D") return "Democratic" as const;
  if (value === "I") return "Independent" as const;
  if (value === "R") return "Republican" as const;
  throw new Error("house_roster_party_invalid");
}

const response = await fetch(SOURCE_URL, {
  headers: { accept: "application/xml,text/xml;q=0.9" },
  redirect: "follow",
  signal: AbortSignal.timeout(30_000),
});
if (
  !response.ok ||
  response.url !== SOURCE_URL ||
  !/^text\/xml(?:;|$)/iu.test(response.headers.get("content-type") ?? "")
) {
  throw new Error("house_roster_source_invalid");
}
const bytes = new Uint8Array(await response.arrayBuffer());
if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_SOURCE_BYTES) {
  throw new Error("house_roster_source_oversized");
}
const parsed = record(new XMLParser({
  attributeNamePrefix: "@",
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
}).parse(new TextDecoder().decode(bytes)), "house_roster_xml_invalid");
const root = record(parsed.MemberData, "house_roster_xml_invalid");
const title = record(root["title-info"], "house_roster_title_invalid");
if (text(title["congress-num"], "house_roster_congress_invalid") !== "119") {
  throw new Error("house_roster_congress_invalid");
}
const members = record(root.members, "house_roster_members_invalid").member;
if (!Array.isArray(members) || members.length < 435 || members.length > 450) {
  throw new Error("house_roster_members_invalid");
}
const entries = [];
const vacancies = [];
for (const value of members) {
  const member = record(value, "house_roster_member_invalid");
  const info = record(member["member-info"], "house_roster_member_invalid");
  const sourceStateDistrict = text(member.statedistrict, "house_roster_district_invalid");
  if (!/^[A-Z]{2}\d{2}$/u.test(sourceStateDistrict)) {
    throw new Error("house_roster_district_invalid");
  }
  const stateRecord = record(info.state, "house_roster_state_invalid");
  const state = text(stateRecord["@postal-code"], "house_roster_state_invalid");
  if (!/^[A-Z]{2}$/u.test(state)) throw new Error("house_roster_state_invalid");
  const bioguideId = typeof info.bioguideID === "string" ? info.bioguideID.trim() : "";
  if (bioguideId === "") {
    vacancies.push(Object.freeze({
      district: sourceStateDistrict.slice(2),
      sourceStateDistrict,
      state,
    }));
    continue;
  }
  if (!/^[A-Z]\d{6}$/u.test(bioguideId)) throw new Error("house_roster_bioguide_invalid");
  entries.push(Object.freeze({
    bioguideId,
    district: sourceStateDistrict.slice(2),
    effectiveFrom: compactDate(info["sworn-date"]),
    effectiveThrough: null,
    officialName: text(info["official-name"], "house_roster_name_invalid"),
    party: party(info.party),
    provenanceUrl: SOURCE_URL,
    sourceStateDistrict,
    state,
  }));
}
entries.sort((left, right) => left.bioguideId.localeCompare(right.bioguideId));
vacancies.sort((left, right) => left.sourceStateDistrict.localeCompare(right.sourceStateDistrict));
if (new Set(entries.map(({ bioguideId }) => bioguideId)).size !== entries.length) {
  throw new Error("house_roster_duplicate_bioguide");
}
const retrievedAtHeader = response.headers.get("date");
if (!retrievedAtHeader || !Number.isFinite(Date.parse(retrievedAtHeader))) {
  throw new Error("house_roster_retrieved_at_invalid");
}
const snapshot = {
  entries,
  schemaVersion: 1,
  source: {
    authority: "Office of the Clerk, U.S. House of Representatives",
    congress: 119,
    contentDigest: createHash("sha256").update(bytes).digest("hex"),
    publishedOn: sourceDate(text(root["@publish-date"], "house_roster_publish_date_invalid")),
    retrievedAt: new Date(retrievedAtHeader).toISOString(),
    rowCount: members.length,
    url: SOURCE_URL,
  },
  vacancies,
};
const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
try {
  const existing = await readFile(OUTPUT_PATH, "utf8");
  if (existing !== serialized) throw new Error("house_roster_snapshot_immutable");
  console.info(JSON.stringify({
    contentDigest: snapshot.source.contentDigest,
    memberCount: snapshot.entries.length,
    outputPath: OUTPUT_PATH,
    status: "already_present",
    vacancyCount: snapshot.vacancies.length,
  }));
} catch (error) {
  if (error instanceof Error && error.message === "house_roster_snapshot_immutable") throw error;
  if (typeof error === "object" && error !== null && Reflect.get(error, "code") !== "ENOENT") throw error;
  await writeFile(OUTPUT_PATH, serialized, { encoding: "utf8", flag: "wx" });
  console.info(JSON.stringify({
    contentDigest: snapshot.source.contentDigest,
    memberCount: snapshot.entries.length,
    outputPath: OUTPUT_PATH,
    status: "created",
    vacancyCount: snapshot.vacancies.length,
  }));
}
