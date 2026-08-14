import type { CallToolResult } from "@ai-sdk/mcp";

export type JsonValue =
  | boolean
  | JsonObject
  | JsonValue[]
  | null
  | number
  | string;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface McpNormalizationPolicy {
  maxArrayItems?: number;
  maxOutputCharacters?: number;
  maxResultItems?: number;
  maxStringCharacters?: number;
  metadataKey?: string;
  priorityKeys?: readonly string[];
  rejectArrayTruncation?: boolean;
}

interface SanitizeLimits {
  maxArrayItems: number;
  maxDepth: number;
  maxStringCharacters: number;
  priorityKeys: readonly string[];
  rejectArrayTruncation: boolean;
  resultItems: number;
}

const DEFAULT_MAX_OUTPUT_CHARACTERS = 120_000;
const DEFAULT_MAX_ARRAY_ITEMS = 50;
const HARD_MAX_ARRAY_ITEMS = 500;
const HARD_MAX_OUTPUT_CHARACTERS = 120_000;
const MAX_OBJECT_KEYS = 100;
const MAX_OMITTED_KEY_NAMES = 50;
const DEFAULT_PRIORITY_KEYS = [
  "serviceId",
  "serviceName",
  "status",
  "inlineArtifactsOmitted",
  "jobId",
  "providerCostUsd",
  "summary",
  "outputs",
  "error",
  "code",
  "message",
  "resourceLinks",
  "outputUrl",
  "downloadUrl",
  "publicUrl",
  "url",
  "uri",
  "results",
  "result",
  "transcript",
  "raw",
] as const;

// Keys that carry a durable artifact reference. When an inline-media result also
// supplies a durable URL, that URL is the only recoverable copy, so it must
// outrank every other field for the context budget regardless of the provider's
// own priority list (which may not mention URL fields at all).
const MANDATORY_ARTIFACT_PRIORITY_KEYS = [
  "resourceLinks",
  "outputUrl",
  "downloadUrl",
  "publicUrl",
  "fileUrl",
  "artifactUrl",
  "url",
  "uri",
  "href",
  "inlineArtifactsOmitted",
] as const;

function withArtifactPriorityKeys(
  keys: readonly string[],
  prepend: boolean,
): readonly string[] {
  if (prepend) {
    const artifact = new Set<string>(MANDATORY_ARTIFACT_PRIORITY_KEYS);
    return [
      ...MANDATORY_ARTIFACT_PRIORITY_KEYS,
      ...keys.filter((key) => !artifact.has(key)),
    ];
  }
  const present = new Set(keys);
  const missing = MANDATORY_ARTIFACT_PRIORITY_KEYS.filter(
    (key) => !present.has(key),
  );
  return missing.length === 0 ? keys : [...keys, ...missing];
}

export class McpToolResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolResultError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function truncatedString(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n[${value.length - maximum} characters omitted]`;
}

function isCredentialField(
  key: string | undefined,
  parent: Record<string, unknown> | undefined,
): boolean {
  const normalized = key?.replaceAll(/[-_]/gu, "").toLowerCase();
  if (!normalized) return false;
  if (
    /(?:apikey|apitoken|authorization|bearertoken|clientsecret|cookies?|credentials?|password|privatekey|secrets?|secretaccesskey|secretkey|setcookie|accesskey|accesskeyid|token|xamzcredential|xamzsignature)$/u.test(
      normalized,
    )
  ) {
    return true;
  }
  return (
    normalized === "policy" &&
    Object.keys(parent ?? {}).some((entry) =>
      entry.toLowerCase().startsWith("x-amz-"),
    )
  );
}

function isSensitiveQueryParameter(key: string): boolean {
  const normalized = key.replaceAll(/[-_.]/gu, "").toLowerCase();
  return (
    normalized === "sig" ||
    /(?:apikey|apitoken|auth|credential|password|policy|secret|signature|token|accesskey)/u.test(
      normalized,
    )
  );
}

function hasSensitiveFragment(url: URL): boolean {
  const fragment = url.hash.slice(1);
  if (!fragment) return false;
  const parameters = new URLSearchParams(fragment);
  return [...parameters.keys()].some(isSensitiveQueryParameter);
}

function isCredentialUrlField(key: string | undefined): boolean {
  const normalized = key?.replaceAll(/[-_.]/gu, "").toLowerCase();
  return (
    normalized === "uploadurl" ||
    normalized === "uploaduri" ||
    normalized === "presignedurl" ||
    normalized === "presigneduri" ||
    normalized === "signedurl" ||
    normalized === "signeduri"
  );
}

function redactUrl(
  value: string,
  redactAllQueryValues: boolean,
  forceRedaction = false,
): string {
  try {
    const url = new URL(value);
    let redacted =
      forceRedaction ||
      Boolean(url.username || url.password) ||
      hasSensitiveFragment(url);
    url.username = "";
    url.password = "";
    if (hasSensitiveFragment(url)) url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (redactAllQueryValues || isSensitiveQueryParameter(key)) {
        url.searchParams.set(key, "[redacted]");
        redacted = true;
      }
    }
    return redacted
      ? `[credential-bearing URL omitted: ${url.origin}]`
      : value;
  } catch {
    return value;
  }
}

interface UriRange {
  end: number;
  start: number;
  value: string;
}

function absoluteUriRanges(value: string): UriRange[] {
  const ranges: UriRange[] = [];
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const separator = value.indexOf("://", searchFrom);
    if (separator < 0) break;
    if (separator < 1) {
      searchFrom = separator + 3;
      continue;
    }

    let start = separator - 1;
    while (
      start >= 0 &&
      /[a-z0-9+.-]/iu.test(value[start] ?? "")
    ) {
      start -= 1;
    }
    start += 1;
    if (!/[a-z]/iu.test(value[start] ?? "")) {
      searchFrom = separator + 3;
      continue;
    }

    let end = separator + 3;
    while (
      end < value.length &&
      !/[\s"'<>`)\]}]/u.test(value[end] ?? "")
    ) {
      end += 1;
    }
    ranges.push({ end, start, value: value.slice(start, end) });
    searchFrom = end;
  }
  return ranges;
}

function labeledCredentialUriStarts(
  value: string,
  ranges: readonly UriRange[],
): Set<number> {
  const starts = new Set<number>();
  let rangeIndex = 0;
  for (const match of value.matchAll(
    /\b(?:pre[-_ ]?signed|signed|upload)[-_ ]?(?:url|uri)\s*[:=]/giu,
  )) {
    const labelEnd = (match.index ?? 0) + match[0].length;
    while (
      rangeIndex < ranges.length &&
      (ranges[rangeIndex]?.start ?? Number.POSITIVE_INFINITY) < labelEnd
    ) {
      rangeIndex += 1;
    }
    const range = ranges[rangeIndex];
    if (range) starts.add(range.start);
  }
  return starts;
}

function redactCredentialUrls(value: string, key: string | undefined): string {
  const ranges = absoluteUriRanges(value);
  if (ranges.length === 0) return value;
  const labeledStarts = labeledCredentialUriStarts(value, ranges);
  const redactAllQueryValues = isCredentialUrlField(key);
  const replacements = ranges.map((range) => {
    const labeled = labeledStarts.has(range.start);
    let replacement = range.value;
    if (
      (labeled || redactAllQueryValues) &&
      !/^https?:\/\//iu.test(range.value)
    ) {
      replacement = "[credential-bearing URI omitted]";
    } else if (/^https?:\/\//iu.test(range.value)) {
      replacement = redactUrl(
        range.value,
        redactAllQueryValues,
        labeled || redactAllQueryValues,
      );
    } else if (hasCredentialBearingUrl(range.value)) {
      replacement = "[credential-bearing URI omitted]";
    }
    return replacement;
  });
  if (
    replacements.every(
      (replacement, index) => replacement === ranges[index]?.value,
    )
  ) {
    return value;
  }
  const chunks: string[] = [];
  let cursor = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (!range) continue;
    chunks.push(value.slice(cursor, range.start), replacements[index] ?? "");
    cursor = range.end;
  }
  chunks.push(value.slice(cursor));
  return chunks.join("");
}

function redactInlineSecrets(value: string): string {
  return value
    .replaceAll(
      /\bBearer\s+[a-zA-Z0-9._~+/-]+={0,2}/giu,
      "Bearer [credential omitted]",
    )
    .replaceAll(
      /\b(?:ghp_|github_pat_|sk_(?:live|test)_|xox[baprs]-)[a-zA-Z0-9_-]{8,}/gu,
      "[credential omitted]",
    )
    .replaceAll(
      /\b((?:api[-_ ]?key|authorization|password|secret|token)\s*[:=]\s*)[^\s,;]+/giu,
      "$1[credential omitted]",
    );
}

function isBinaryString(
  key: string | undefined,
  value: string,
  parent: Record<string, unknown> | undefined,
): boolean {
  if (/^data:[^;,]+;base64,/iu.test(value)) return true;
  const normalizedKey = key?.replaceAll(/[-_]/gu, "").toLowerCase();
  if (
    normalizedKey &&
    /(?:base64|b64json|image(?:bytes|data)?s?|audio(?:bytes|data)?s?|video(?:bytes|data)?s?|filebytes|blobs?)$/u.test(normalizedKey)
  ) {
    return value.length > 1_024;
  }
  if (
    key === "data" &&
    value.length > 4_096 &&
    !/[^\S\r\n]/u.test(value) &&
    /^[a-zA-Z0-9+/_=-]+$/u.test(value.replaceAll(/[\r\n]/gu, ""))
  ) {
    return true;
  }
  return (
    key === "data" &&
    value.length > 1_024 &&
    /^(?:audio|file|image|video)$/u.test(
      String(parent?.type ?? "").toLowerCase(),
    )
  );
}

function prioritizedEntries<T>(
  value: Record<string, T>,
  priorityKeys: readonly string[],
): [string, T][] {
  const priorities = new Map<string, number>(
    priorityKeys.map((entry, index) => [entry, index] as const),
  );
  return Object.entries(value).sort(([left], [right]) => {
    const leftPriority = priorities.get(left) ?? priorityKeys.length;
    const rightPriority = priorities.get(right) ?? priorityKeys.length;
    return leftPriority - rightPriority;
  });
}

function boundedNameList(names: readonly string[]): JsonValue[] {
  if (names.length <= MAX_OMITTED_KEY_NAMES) return [...names];
  return [
    ...names.slice(0, MAX_OMITTED_KEY_NAMES),
    `[${names.length - MAX_OMITTED_KEY_NAMES} more field names omitted]`,
  ];
}

function sanitizeValue(
  value: unknown,
  limits: SanitizeLimits,
  depth = 0,
  key?: string,
  parent?: Record<string, unknown>,
): JsonValue {
  if (isCredentialField(key, parent)) return "[credential omitted]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const redacted = redactInlineSecrets(redactCredentialUrls(value, key));
    if (/^https?:\/\//iu.test(redacted)) {
      return truncatedString(redacted, limits.maxStringCharacters);
    }
    if (isBinaryString(key, value, parent)) {
      return `[binary payload omitted: ${value.length} characters]`;
    }
    return truncatedString(redacted, limits.maxStringCharacters);
  }
  if (depth >= limits.maxDepth) {
    return `[nested data omitted: exceeds Eve's ${limits.maxDepth}-level depth limit]`;
  }

  if (Array.isArray(value)) {
    const maximum =
      key === "results"
        ? limits.resultItems
        : key === "transcript"
          ? 500
          : limits.maxArrayItems;
    const result = value
      .slice(0, maximum)
      .map((entry) =>
        sanitizeValue(entry, limits, depth + 1, key, parent),
      );
    if (value.length > maximum) {
      if (limits.rejectArrayTruncation) {
        throw new McpToolResultError(
          "The MCP result contained more list items than Eve can safely retain. Retry with a smaller page limit or a narrower query.",
        );
      }
      result.push(`[${value.length - maximum} additional items omitted]`);
    }
    return result;
  }

  if (!isRecord(value)) return String(value);

  const result: JsonObject = {};
  const entries = prioritizedEntries(value, limits.priorityKeys);
  for (const [entryKey, entry] of entries.slice(0, MAX_OBJECT_KEYS)) {
    if (entry === undefined) continue;
    result[entryKey] = sanitizeValue(
      entry,
      limits,
      depth + 1,
      entryKey,
      value,
    );
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    result.fieldsOmitted = entries.length - MAX_OBJECT_KEYS;
    // Report which fields were dropped, not just how many, so the model knows a
    // field exists and can ask for it instead of assuming it was never returned.
    result.fieldsOmittedNames = boundedNameList(
      entries.slice(MAX_OBJECT_KEYS).map(([entryKey]) => entryKey),
    );
  }
  return result;
}

function jsonLength(value: JsonValue): number {
  return JSON.stringify(value).length;
}

function fitStringToBudget(value: string, maximum: number): string {
  if (jsonLength(value) <= maximum) return value;
  const marker = "\n[truncated to context budget]";
  if (jsonLength(marker) > maximum) return "";

  let lower = 0;
  let upper = value.length;
  let best = marker;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = `${value.slice(0, middle)}${marker}`;
    if (jsonLength(candidate) <= maximum) {
      best = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return best;
}

function orderedEntries(
  value: JsonObject,
  priorityKeys: readonly string[],
): [string, JsonValue][] {
  return prioritizedEntries(value, priorityKeys);
}

function fitToBudget(
  value: JsonValue,
  maximum: number,
  priorityKeys: readonly string[],
  rejectArrayTruncation: boolean,
): JsonValue {
  if (jsonLength(value) <= maximum) return value;
  if (typeof value === "string") return fitStringToBudget(value, maximum);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    let omitted = 0;
    for (let index = 0; index < value.length; index += 1) {
      const remaining = maximum - jsonLength(result) - 2;
      if (remaining < 4) {
        omitted = value.length - index;
        break;
      }
      const entry = fitToBudget(
        value[index],
        remaining,
        priorityKeys,
        rejectArrayTruncation,
      );
      const candidate = [...result, entry];
      if (jsonLength(candidate) > maximum) {
        omitted = value.length - index;
        break;
      }
      result.push(entry);
    }
    if (omitted > 0) {
      if (rejectArrayTruncation) {
        throw new McpToolResultError(
          "The MCP result exceeded Eve's safe list context budget. Retry with a smaller page limit or a narrower query.",
        );
      }
      let marker = `[${omitted} additional items omitted by context budget]`;
      while (
        result.length > 0 &&
        jsonLength([...result, marker]) > maximum
      ) {
        result.pop();
        omitted += 1;
        marker = `[${omitted} additional items omitted by context budget]`;
      }
      if (jsonLength([...result, marker]) <= maximum) result.push(marker);
    }
    return result;
  }

  const result: JsonObject = {};
  let omitted = 0;
  for (const [key, entry] of orderedEntries(value, priorityKeys)) {
    const remaining =
      maximum - jsonLength(result) - JSON.stringify(key).length - 3;
    if (remaining < 4) {
      omitted += 1;
      continue;
    }
    const fitted = fitToBudget(
      entry,
      remaining,
      priorityKeys,
      rejectArrayTruncation,
    );
    const candidate = { ...result, [key]: fitted };
    if (jsonLength(candidate) <= maximum) result[key] = fitted;
    else omitted += 1;
  }
  if (omitted > 0) {
    for (const [key, entry] of [
      ["resultTruncated", true],
      ["fieldsOmittedByContextBudget", omitted],
    ] as const) {
      const candidate = { ...result, [key]: entry };
      if (jsonLength(candidate) <= maximum) result[key] = entry;
    }
  }
  return result;
}

function boundedValue(
  value: unknown,
  options: McpNormalizationPolicy,
  prependArtifactKeys = false,
): JsonValue {
  const maxOutputCharacters = boundedLimit(
    options.maxOutputCharacters,
    DEFAULT_MAX_OUTPUT_CHARACTERS,
    HARD_MAX_OUTPUT_CHARACTERS,
  );
  // Durable artifact-URL keys are always kept in the priority list so a provider
  // policy that omits them cannot push a URL below unknown fields; when the
  // result carries inline media, those keys move to the very front so the one
  // recoverable reference survives the budget ahead of everything else.
  const priorityKeys = withArtifactPriorityKeys(
    options.priorityKeys ?? DEFAULT_PRIORITY_KEYS,
    prependArtifactKeys,
  );
  const normalLimits: SanitizeLimits = {
    maxArrayItems: boundedLimit(
      options.maxArrayItems,
      DEFAULT_MAX_ARRAY_ITEMS,
      HARD_MAX_ARRAY_ITEMS,
    ),
    maxDepth: 10,
    maxStringCharacters: boundedLimit(
      options.maxStringCharacters,
      maxOutputCharacters,
      maxOutputCharacters,
    ),
    priorityKeys,
    rejectArrayTruncation: options.rejectArrayTruncation ?? false,
    resultItems: boundedLimit(
      options.maxResultItems,
      DEFAULT_MAX_ARRAY_ITEMS,
      HARD_MAX_ARRAY_ITEMS,
    ),
  };
  const sanitized = sanitizeValue(value, normalLimits);
  const fitted = fitToBudget(
    sanitized,
    maxOutputCharacters,
    priorityKeys,
    normalLimits.rejectArrayTruncation,
  );
  if (jsonLength(fitted) <= maxOutputCharacters) return fitted;
  return fitStringToBudget(JSON.stringify(sanitized), maxOutputCharacters);
}

function textParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    isRecord(part) &&
    part.type === "text" &&
    typeof part.text === "string"
      ? [part.text]
      : [],
  );
}

function hasCredentialBearingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      Boolean(url.username || url.password) ||
      [...url.searchParams.keys()].some(isSensitiveQueryParameter) ||
      hasSensitiveFragment(url)
    );
  } catch {
    return false;
  }
}

function containsUnsafeUrl(value: string, key: string | undefined): boolean {
  const ranges = absoluteUriRanges(value);
  if (ranges.length === 0) return false;
  const labeledStarts = labeledCredentialUriStarts(value, ranges);
  return ranges.some(
    (candidate) =>
      labeledStarts.has(candidate.start) ||
      isCredentialUrlField(key) ||
      hasCredentialBearingUrl(candidate.value),
  );
}

function assertSafeOutputUrls(
  value: unknown,
  key?: string,
  seen = new Set<object>(),
): void {
  if (typeof value === "string") {
    if (containsUnsafeUrl(value, key)) {
      throw new McpToolResultError(
        "The MCP service returned a credential-bearing output URL instead of a safe durable URL, so Eve did not retain it. The service may have completed and been charged, so do not repay or retry this call; recover the result from the provider's existing job or usage history instead.",
      );
    }
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeOutputUrls(entry, key, seen);
    return;
  }
  for (const [entryKey, entry] of Object.entries(value)) {
    assertSafeOutputUrls(entry, entryKey, seen);
  }
}

function containsInlineBinary(
  value: unknown,
  key?: string,
  parent?: Record<string, unknown>,
  seen = new Set<object>(),
): boolean {
  if (typeof value === "string") {
    return !/^https?:\/\//iu.test(value) && isBinaryString(key, value, parent);
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) =>
      containsInlineBinary(entry, key, parent, seen),
    );
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([entryKey, entry]) =>
    containsInlineBinary(entry, entryKey, value, seen),
  );
}

function isInlineMediaMetadataKey(key: string): boolean {
  const normalized = key.replaceAll(/[-_.]/gu, "").toLowerCase();
  return /^(?:bytelength|bytes|contenttype|duration|durationms|encoding|filename|format|height|mediatype|mimetype|name|size|type|width)$/u.test(
    normalized,
  );
}

function hasUsableNonBinaryContent(
  value: unknown,
  key?: string,
  parent?: Record<string, unknown>,
  seen = new Set<object>(),
  mediaEnvelope = false,
): boolean {
  if (typeof value === "string") {
    if (isBinaryString(key, value, parent)) return false;
    if (mediaEnvelope && key && isInlineMediaMetadataKey(key)) return false;
    return value.trim().length > 0;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return !(mediaEnvelope && key && isInlineMediaMetadataKey(key));
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) =>
      hasUsableNonBinaryContent(
        entry,
        key,
        parent,
        seen,
        mediaEnvelope,
      ),
    );
  }
  if (!isRecord(value)) return false;

  const entries = Object.entries(value);
  const isMediaEnvelope = entries.some(([entryKey, entry]) =>
    containsInlineBinary(entry, entryKey, value),
  );
  return entries.some(([entryKey, entry]) =>
    hasUsableNonBinaryContent(
      entry,
      entryKey,
      value,
      seen,
      isMediaEnvelope,
    ),
  );
}

function isArtifactUrlField(key: string): boolean {
  const normalized = key.replaceAll(/[-_.]/gu, "").toLowerCase();
  return /^(?:artifacturl|downloadurl|fileurl|href|outputurl|publicurl|uri|url)$/u.test(
    normalized,
  );
}

function hasDurableArtifactReference(
  value: unknown,
  key?: string,
  seen = new Set<object>(),
): boolean {
  if (typeof value === "string") {
    return (
      Boolean(key && isArtifactUrlField(key)) &&
      /^https?:\/\//iu.test(value) &&
      !/\s/u.test(value) &&
      !containsUnsafeUrl(value, key)
    );
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) =>
      hasDurableArtifactReference(entry, key, seen),
    );
  }
  return Object.entries(value).some(([entryKey, entry]) =>
    hasDurableArtifactReference(entry, entryKey, seen),
  );
}

function annotateInlineArtifactsOmitted(value: unknown): unknown {
  return isRecord(value)
    ? { ...value, inlineArtifactsOmitted: true }
    : { result: value, inlineArtifactsOmitted: true };
}

function errorMessage(result: CallToolResult): string {
  const text = textParts(Reflect.get(result, "content")).join("\n").trim();
  const fallback = "The MCP service returned an unsuccessful result.";
  let safeText: string;
  try {
    safeText = JSON.stringify(
      boundedValue(JSON.parse(text) as unknown, {
        maxOutputCharacters: 2_000,
        maxStringCharacters: 1_000,
      }),
    );
  } catch {
    safeText = redactInlineSecrets(
      redactCredentialUrls(text || fallback, undefined),
    );
  }
  return truncatedString(
    safeText || fallback,
    2_000,
  );
}

function resourceLinks(content: unknown): JsonValue[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (
      !isRecord(part) ||
      part.type !== "resource_link" ||
      typeof part.uri !== "string"
    ) {
      return [];
    }
    return [
      {
        type: "resource_link",
        uri: part.uri,
        ...(typeof part.name === "string" ? { name: part.name } : {}),
        ...(typeof part.description === "string"
          ? { description: part.description }
          : {}),
        ...(typeof part.mimeType === "string"
          ? { mimeType: part.mimeType }
          : {}),
      },
    ];
  });
}

function withResourceLinks(value: unknown, links: JsonValue[]): unknown {
  if (links.length === 0) return value;
  return isRecord(value)
    ? { ...value, resourceLinks: links }
    : { result: value, resourceLinks: links };
}

export function normalizeMcpToolResult(
  result: CallToolResult,
  options: McpNormalizationPolicy = {},
): JsonValue {
  if (result.isError) throw new McpToolResultError(errorMessage(result));

  const content = Reflect.get(result, "content");
  const links = resourceLinks(content);
  const structured = Reflect.get(result, "structuredContent");
  let selected: unknown;
  if (structured !== undefined && structured !== null) {
    selected = structured;
  } else {
    const toolResult = Reflect.get(result, "toolResult");
    if (toolResult !== undefined) {
      selected = toolResult;
    } else {
      const metadata = Reflect.get(result, "_meta");
      const selectedMetadata =
        isRecord(metadata) && options.metadataKey
          ? metadata[options.metadataKey]
          : undefined;
      if (selectedMetadata !== undefined && selectedMetadata !== null) {
        selected = selectedMetadata;
      }
    }
  }

  if (selected === undefined) {
    const texts = textParts(content);
    if (texts.length === 1) {
      try {
        selected = JSON.parse(texts[0]) as unknown;
      } catch {
        selected = texts[0];
      }
    } else {
      selected = { content };
    }
  }

  const selectedWithLinks = withResourceLinks(selected, links);
  assertSafeOutputUrls(selectedWithLinks);

  const hasInlineBinary =
    containsInlineBinary(content) || containsInlineBinary(selectedWithLinks);
  const hasDurableArtifact = hasDurableArtifactReference(selectedWithLinks);

  // Inline media (base64 image/audio/video/file) can never enter model history,
  // and this synchronous normalizer cannot publish it. But rejecting the whole
  // result is only correct when the media was the sole useful deliverable. When
  // the provider also returned usable structured/text data, keep that data and
  // record that a non-retained artifact rode along.
  if (
    hasInlineBinary &&
    !hasDurableArtifact &&
    !hasUsableNonBinaryContent(selectedWithLinks)
  ) {
    throw new McpToolResultError(
      "The MCP service returned inline media without a durable URL, so Eve did not retain the binary payload. The service may have completed and been charged, so do not repay or retry this call; recover the result from the provider's existing job or usage history instead.",
    );
  }

  const projected =
    hasInlineBinary && !hasDurableArtifact
      ? annotateInlineArtifactsOmitted(selectedWithLinks)
      : selectedWithLinks;

  const bounded = boundedValue(
    projected,
    options,
    hasInlineBinary && hasDurableArtifact,
  );

  // A durable URL that the provider DID supply must not be silently dropped by
  // the context budget while its inline media is stripped; fail explicitly so
  // the artifact is never reported as lost without a recovery path.
  if (
    hasInlineBinary &&
    hasDurableArtifact &&
    !hasDurableArtifactReference(bounded)
  ) {
    throw new McpToolResultError(
      "The MCP service returned inline media whose durable URL could not fit safely in Eve's context, so Eve did not retain the result. The service may have completed and been charged, so do not repay or retry this call; recover the result from the provider's existing job or usage history instead.",
    );
  }
  return bounded;
}
