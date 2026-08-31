# House PTR 8221359 regression evidence

`ptr-8221359.pdf` is the public five-page House Clerk filing. Its digest is pinned in the golden file. The 123 source-corrected transactions include two K-band entries (“Spouse/DC Asset Over $1,000,000”), which must not become J. Page-4 transaction 21 is B; source inspection corrected a mistaken earlier A expectation.

`ptr-8221359.real-models.json` records the successful registered recovery using definition 1.0.18, `anthropic/claude-haiku-4.5` extraction, and independent `google/gemini-3-flash` transcription on 2026-08-31 UTC. This is public source-derived candidate/evidence and usage only, without credentials or job authority. The real attempt used 201005 input and 15786 output tokens and settled $0.185881 against a $1 admission ceiling. All 123 rows, signed provenance, complete acquisition with 124 canonical facts, baseline without alerts, settled accounting, and unchanged replay passed in isolated test storage. This is not a production-release receipt.

Replay without paid calls from the repository root:

```sh
./node_modules/.bin/jiti scripts/verify-house-legacy-golden.ts --replay-output=scripts/fixtures/public-source-adapters/house/live-review-2026-08-30/ptr-8221359.real-models.json
```

The default verification also checks ambiguous/missing grid marks, forged crops, row membership/order, date validity, incomplete evidence, bounded retry, durable paid receipts, and lost acknowledgments. The Dallas row on page 5 prints `02-17-2026`; exact four-digit-year US dates with either slashes or hyphens must normalize to ISO without accepting appended text or guessing incomplete dates. Zero-padded physical row keys keep lexical schema order consistent with source order. Independent OCR receives exact row strips; candidate type/amount values come from checked grid pixels, not model guesses.

Uncertain spend remains conservative. Successful pages/extraction are reused on a missing-page retry, which reserves remaining work with the signed worker minimum rather than reserving the entire filing again. A test covers a 400k uncertain allowance plus a 100k missing-page retry within a 500k/day input cap. Hard monetary limits are unchanged. Factual disagreement still quarantines and cannot pass by row count alone.
