import { runSecIpoReadOnlyLiveSmoke } from "../agent/lib/sec-ipo-live-smoke";

const result = await runSecIpoReadOnlyLiveSmoke({
  userAgent: process.env.SEC_USER_AGENT,
});
console.info(JSON.stringify({
  baselineEstablished: result.evaluation.baselineEstablished,
  checkpoint: result.evaluation.checkpoint,
  filingCount: result.page.filings.length,
  sourceId: result.page.sourceId,
}));
