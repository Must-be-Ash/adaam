import {
  evaluateSecIpoPage,
  normalizeSecIpoFetch,
  type SecIpoEvaluation,
} from "./sec-ipo-evaluation";
import {
  SEC_IPO_SOURCE_URL,
  type SecIpoAtomPage,
} from "./sec-ipo-reference";

const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const FETCH_TIMEOUT_MS = 20_000;

export class SecIpoLiveSmokeError extends Error {
  readonly code:
    | "sec_live_fetch_failed"
    | "sec_live_response_oversized"
    | "sec_user_agent_invalid";

  constructor(code: SecIpoLiveSmokeError["code"]) {
    super(code);
    this.code = code;
    this.name = "SecIpoLiveSmokeError";
  }
}

function declaredUserAgent(value: string | undefined): string {
  const userAgent = value?.trim() ?? "";
  const contact = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/iu.exec(userAgent);
  if (
    userAgent.length < 10 ||
    userAgent.length > 240 ||
    /[\r\n]/u.test(userAgent) ||
    !contact?.[1] ||
    /(?:^|\.)(?:example|invalid|localhost|test)$/iu.test(contact[1])
  ) {
    throw new SecIpoLiveSmokeError("sec_user_agent_invalid");
  }
  return userAgent;
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return body + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SecIpoLiveSmokeError("sec_live_response_oversized");
    }
    body += decoder.decode(value, { stream: true });
  }
}

export async function runSecIpoReadOnlyLiveSmoke(input: {
  fetch?: typeof fetch;
  now?: Date;
  userAgent?: string;
}): Promise<{
  evaluation: SecIpoEvaluation;
  page: SecIpoAtomPage;
}> {
  const fetcher = input.fetch ?? fetch;
  const userAgent = declaredUserAgent(input.userAgent);
  const observedAt = (input.now ?? new Date()).toISOString();
  const response = await fetcher(SEC_IPO_SOURCE_URL, {
    headers: {
      accept: "application/atom+xml, application/xml;q=0.9",
      "user-agent": userAgent,
    },
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => {
    throw new SecIpoLiveSmokeError("sec_live_fetch_failed");
  });
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new SecIpoLiveSmokeError("sec_live_response_oversized");
  }
  const body = await readBoundedBody(response);
  const page = normalizeSecIpoFetch({
    body,
    contentType: response.headers.get("content-type") ?? "",
    finalUrl: response.url || SEC_IPO_SOURCE_URL,
    observedAt,
    requestedUrl: SEC_IPO_SOURCE_URL,
    status: response.status,
  });
  return {
    evaluation: evaluateSecIpoPage(page, null, {
      ownerId: "owner_live_smoke",
      workspaceId: "00000000-0000-4000-8000-000000000001",
    }),
    page,
  };
}
