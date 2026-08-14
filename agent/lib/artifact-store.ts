import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { get, put } from "@vercel/blob";

import {
  artifactIdSchema,
  artifactManifestSchema,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_MANIFEST_BYTES,
  type ArtifactKind,
  type ArtifactManifest,
  type ResearchReport,
} from "#artifact-schema";
import { artifactPageUrl } from "#public-app-url";

const ARTIFACT_PATH_PREFIX = "artifacts";
const ARTIFACT_CACHE_SECONDS = 31_536_000;
const MANIFEST_CACHE_SECONDS = 60;
const REMOTE_FETCH_TIMEOUT_MS = 90_000;
const MAX_REMOTE_REDIRECTS = 4;

const MEDIA_CONTENT_TYPES: Record<Exclude<ArtifactKind, "report" | "file">, Set<string>> =
  {
    audio: new Set([
      "audio/aac",
      "audio/flac",
      "audio/mpeg",
      "audio/mp4",
      "audio/ogg",
      "audio/wav",
      "audio/webm",
      "audio/x-wav",
    ]),
    image: new Set([
      "image/avif",
      "image/gif",
      "image/heic",
      "image/heif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]),
    pdf: new Set(["application/pdf"]),
    video: new Set([
      "video/mp4",
      "video/ogg",
      "video/quicktime",
      "video/webm",
      "video/x-m4v",
    ]),
  };

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "application/json": "json",
  "application/pdf": "pdf",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-wav": "wav",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/plain": "txt",
  "video/mp4": "mp4",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-m4v": "m4v",
};

export interface PublishedArtifact {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly publicUrl: string;
}

interface PublishMediaInput {
  readonly artifactId: string;
  readonly contentType?: string;
  readonly description: string;
  readonly fileName?: string;
  readonly kind: Exclude<ArtifactKind, "report">;
  readonly signal?: AbortSignal;
  readonly sourceUrl: string;
  readonly title: string;
}

interface PublishTextFileInput {
  readonly artifactId: string;
  readonly contentType?: string;
  readonly description: string;
  readonly fileName: string;
  readonly signal?: AbortSignal;
  readonly text: string;
  readonly title: string;
}

function artifactManifestPath(artifactId: string): string {
  return `${ARTIFACT_PATH_PREFIX}/${artifactId}/manifest.json`;
}

function normalizeContentType(value: string | null | undefined): string | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)
    ? normalized
    : null;
}

function contentTypeFromFileName(fileName: string | undefined): string | null {
  const extension = fileName?.toLowerCase().match(/\.([a-z0-9]{1,10})$/u)?.[1];
  if (!extension) return null;
  return (
    Object.entries(CONTENT_TYPE_EXTENSIONS).find(
      ([, candidateExtension]) => candidateExtension === extension,
    )?.[0] ?? null
  );
}

function canonicalContentType(value: string): string {
  return value === "audio/x-wav" ? "audio/wav" : value;
}

function resolveRemoteContentType(input: {
  expected?: string;
  fileName?: string;
  response: string | null;
}): string {
  const expected = normalizeContentType(input.expected);
  const response = normalizeContentType(input.response);
  const inferred = contentTypeFromFileName(input.fileName);

  if (input.expected && !expected) {
    throw new Error("The requested artifact content type is invalid.");
  }
  if (
    expected &&
    response &&
    response !== "application/octet-stream" &&
    canonicalContentType(expected) !== canonicalContentType(response)
  ) {
    throw new Error("The artifact source returned a different content type.");
  }

  const meaningfulResponse =
    response === "application/octet-stream" ? null : response;
  return (
    expected ??
    meaningfulResponse ??
    inferred ??
    response ??
    "application/octet-stream"
  );
}

function validateKindContentType(
  kind: Exclude<ArtifactKind, "report">,
  contentType: string,
): void {
  if (kind === "file") return;
  if (!MEDIA_CONTENT_TYPES[kind].has(contentType)) {
    throw new Error(`The source is not a supported ${kind} artifact.`);
  }
}

function ipv4IsPublic(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [a, b] = octets;
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  ) {
    return false;
  }
  return true;
}

function ipv6IsPublic(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  ) {
    return false;
  }

  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  return mappedIpv4 ? ipv4IsPublic(mappedIpv4) : true;
}

function ipAddressIsPublic(address: string): boolean {
  const version = isIP(address);
  return version === 4
    ? ipv4IsPublic(address)
    : version === 6
      ? ipv6IsPublic(address)
      : false;
}

async function assertPublicRemoteUrl(url: URL): Promise<void> {
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Artifact sources must use a public HTTPS URL.");
  }

  if (isIP(hostname)) {
    if (!ipAddressIsPublic(hostname)) {
      throw new Error("Artifact sources cannot use a private network address.");
    }
    return;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !ipAddressIsPublic(address))
  ) {
    throw new Error("The artifact source did not resolve to a public address.");
  }
}

function combineAbortSignals(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchPublicArtifactSource(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<Response> {
  let currentUrl = new URL(sourceUrl);
  const combinedSignal = combineAbortSignals(signal);

  for (let redirect = 0; redirect <= MAX_REMOTE_REDIRECTS; redirect += 1) {
    await assertPublicRemoteUrl(currentUrl);
    const response = await fetch(currentUrl, {
      headers: {
        Accept: "image/*, audio/*, video/*, application/pdf, application/octet-stream",
        "User-Agent": "EveArtifactPublisher/1.0",
      },
      redirect: "manual",
      signal: combinedSignal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REMOTE_REDIRECTS) {
        throw new Error("The artifact source redirected too many times.");
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok || !response.body) {
      throw new Error("The artifact source could not be downloaded.");
    }
    return response;
  }

  throw new Error("The artifact source redirected too many times.");
}

function bytesStartWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function contentSignatureMatches(
  bytes: Uint8Array,
  contentType: string,
): boolean {
  switch (contentType) {
    case "application/pdf":
      return ascii(bytes, 0, 5) === "%PDF-";
    case "image/png":
      return bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return ascii(bytes, 0, 4) === "GIF8";
    case "image/webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
    case "image/avif":
      return ascii(bytes, 4, 8) === "ftyp" && ascii(bytes, 8, 12).includes("avif");
    case "image/heic":
    case "image/heif":
      return ascii(bytes, 4, 8) === "ftyp";
    case "audio/wav":
    case "audio/x-wav":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE";
    case "audio/mpeg":
      return (
        ascii(bytes, 0, 3) === "ID3" ||
        (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)
      );
    case "audio/mp4":
    case "video/mp4":
    case "video/quicktime":
    case "video/x-m4v":
      return ascii(bytes, 4, 8) === "ftyp";
    case "audio/webm":
    case "video/webm":
      return bytesStartWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    default:
      return bytes.length > 0;
  }
}

async function boundedRemoteBody(input: {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string;
}): Promise<{
  readonly body: ReadableStream<Uint8Array>;
  readonly byteLength: () => number;
}> {
  const reader = input.body.getReader();
  const initialChunks: Uint8Array[] = [];
  let initialLength = 0;

  while (initialLength < 64) {
    const result = await reader.read();
    if (result.done) break;
    initialChunks.push(result.value);
    initialLength += result.value.byteLength;
  }

  const prefix = new Uint8Array(initialLength);
  let prefixOffset = 0;
  for (const chunk of initialChunks) {
    prefix.set(chunk, prefixOffset);
    prefixOffset += chunk.byteLength;
  }
  if (!contentSignatureMatches(prefix, input.contentType)) {
    await reader.cancel().catch(() => undefined);
    throw new Error("The artifact content does not match its declared type.");
  }

  let byteLength = 0;
  let initialIndex = 0;
  const stream = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
    async pull(controller) {
      const next =
        initialIndex < initialChunks.length
          ? { done: false as const, value: initialChunks[initialIndex++] }
          : await reader.read();
      if (next.done) {
        controller.close();
        return;
      }

      byteLength += next.value.byteLength;
      if (byteLength > MAX_ARTIFACT_BYTES) {
        await reader.cancel().catch(() => undefined);
        controller.error(
          new Error("The artifact exceeds the 100 MB publication limit."),
        );
        return;
      }
      controller.enqueue(next.value);
    },
  });

  return { body: stream, byteLength: () => byteLength };
}

function sanitizeFileName(
  requested: string | undefined,
  contentType: string,
  kind: Exclude<ArtifactKind, "report">,
): string {
  const fallback = kind === "file" ? "artifact" : kind;
  const cleaned = (requested ?? fallback)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/^[.\s]+|[.\s]+$/gu, "")
    .replace(/\s+/gu, "-")
    .slice(0, 120);
  const base = cleaned || fallback;
  if (kind === "file" && /\.[a-z0-9]{1,10}$/iu.test(base)) return base;

  const extension = CONTENT_TYPE_EXTENSIONS[contentType] ?? "bin";
  return `${base.replace(/\.[a-z0-9]{1,10}$/iu, "")}.${extension}`;
}

function mediaStorageContentType(
  kind: Exclude<ArtifactKind, "report">,
  contentType: string,
): string {
  return kind === "file" ? "application/octet-stream" : contentType;
}

async function writeManifest(
  manifest: ArtifactManifest,
  signal?: AbortSignal,
): Promise<void> {
  const validated = artifactManifestSchema.parse(manifest);
  const serialized = JSON.stringify(validated);
  if (Buffer.byteLength(serialized, "utf8") > MAX_ARTIFACT_MANIFEST_BYTES) {
    throw new Error("The artifact manifest exceeds the 1 MB limit.");
  }

  await put(artifactManifestPath(validated.id), serialized, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    abortSignal: signal,
    cacheControlMaxAge: MANIFEST_CACHE_SECONDS,
    contentType: "application/json; charset=utf-8",
  });
}

export function artifactIdForCall(callId: string): string {
  return createHash("sha256")
    .update(`eve-artifact-v1\u0000${callId}`)
    .digest("hex")
    .slice(0, 32);
}

export async function publishReportArtifact(input: {
  readonly artifactId: string;
  readonly report: ResearchReport;
  readonly signal?: AbortSignal;
}): Promise<PublishedArtifact> {
  const artifactId = artifactIdSchema.parse(input.artifactId);
  const publicUrl = artifactPageUrl(artifactId);
  const manifest: ArtifactManifest = {
    createdAt: new Date().toISOString(),
    description: input.report.description,
    id: artifactId,
    kind: "report",
    report: input.report,
    schemaVersion: 1,
    title: input.report.title,
    visibility: "public",
  };
  await writeManifest(manifest, input.signal);
  return {
    artifactId,
    kind: "report",
    publicUrl,
  };
}

export async function publishRemoteMediaArtifact(
  input: PublishMediaInput,
): Promise<PublishedArtifact> {
  const artifactId = artifactIdSchema.parse(input.artifactId);
  const publicUrl = artifactPageUrl(artifactId);
  const response = await fetchPublicArtifactSource(input.sourceUrl, input.signal);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTIFACT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("The artifact exceeds the 100 MB publication limit.");
  }

  const sourceContentType = resolveRemoteContentType({
    expected: input.contentType,
    fileName: input.fileName ?? new URL(input.sourceUrl).pathname,
    response: response.headers.get("content-type"),
  });
  validateKindContentType(input.kind, sourceContentType);

  const fileName = sanitizeFileName(
    input.fileName ?? new URL(input.sourceUrl).pathname.split("/").at(-1),
    sourceContentType,
    input.kind,
  );
  const bounded = await boundedRemoteBody({
    body: response.body!,
    contentType: sourceContentType,
  });
  const storedContentType = mediaStorageContentType(
    input.kind,
    sourceContentType,
  );
  const mediaBlob = await put(
    `${ARTIFACT_PATH_PREFIX}/${artifactId}/${fileName}`,
    bounded.body,
    {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      abortSignal: input.signal,
      cacheControlMaxAge: ARTIFACT_CACHE_SECONDS,
      contentType: storedContentType,
      maximumSizeInBytes: MAX_ARTIFACT_BYTES,
      multipart: true,
    },
  );

  const manifest: ArtifactManifest = {
    createdAt: new Date().toISOString(),
    description: input.description,
    id: artifactId,
    kind: input.kind,
    media: {
      byteLength: bounded.byteLength(),
      contentType: storedContentType,
      downloadUrl: mediaBlob.downloadUrl,
      fileName,
      url: mediaBlob.url,
    },
    schemaVersion: 1,
    title: input.title,
    visibility: "public",
  };

  await writeManifest(manifest, input.signal);

  return {
    artifactId,
    kind: input.kind,
    publicUrl,
  };
}

export async function publishTextFileArtifact(
  input: PublishTextFileInput,
): Promise<PublishedArtifact> {
  const artifactId = artifactIdSchema.parse(input.artifactId);
  const publicUrl = artifactPageUrl(artifactId);
  const sourceContentType =
    normalizeContentType(input.contentType) ?? contentTypeFromFileName(input.fileName);
  if (
    sourceContentType &&
    !["application/json", "text/csv", "text/plain"].includes(sourceContentType)
  ) {
    throw new Error("Text artifacts support plain text, CSV, or JSON content.");
  }

  const content = Buffer.from(input.text, "utf8");
  if (content.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error("The artifact exceeds the 100 MB publication limit.");
  }
  const fileName = sanitizeFileName(
    input.fileName,
    sourceContentType ?? "text/plain",
    "file",
  );
  const mediaBlob = await put(
    `${ARTIFACT_PATH_PREFIX}/${artifactId}/${fileName}`,
    content,
    {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      abortSignal: input.signal,
      cacheControlMaxAge: ARTIFACT_CACHE_SECONDS,
      contentType: "application/octet-stream",
    },
  );

  const manifest: ArtifactManifest = {
    createdAt: new Date().toISOString(),
    description: input.description,
    id: artifactId,
    kind: "file",
    media: {
      byteLength: content.byteLength,
      contentType: "application/octet-stream",
      downloadUrl: mediaBlob.downloadUrl,
      fileName,
      url: mediaBlob.url,
    },
    schemaVersion: 1,
    title: input.title,
    visibility: "public",
  };

  await writeManifest(manifest, input.signal);

  return {
    artifactId,
    kind: "file",
    publicUrl,
  };
}

export async function readArtifactManifest(
  artifactId: string,
): Promise<ArtifactManifest | null> {
  const parsedId = artifactIdSchema.safeParse(artifactId);
  if (!parsedId.success) return null;

  const result = await get(artifactManifestPath(parsedId.data), {
    access: "public",
    useCache: true,
  });
  if (!result || result.statusCode !== 200) return null;
  if (result.blob.size > MAX_ARTIFACT_MANIFEST_BYTES) return null;

  try {
    const serialized = await new Response(result.stream).text();
    const manifest = artifactManifestSchema.parse(JSON.parse(serialized));
    return manifest.id === parsedId.data ? manifest : null;
  } catch {
    return null;
  }
}
