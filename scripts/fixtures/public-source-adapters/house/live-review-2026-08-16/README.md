# House PTR live viability corpus — 2026-08-16

This owner-authorized, read-only corpus contains the official 2026 House index
and the literal newest 20 PTR PDFs as observed on 2026-08-16. The sample spans
18 distinct disclosed members and filing dates from 2026-08-05 through
2026-08-13. `manifest.json` records source URLs, hashes, independent visual
classification, production-parser outcomes, and the aggregate gate result.

All 20 documents are visibly transaction-bearing. The production Spec 3 parser
produced no `house-ptr-transaction/v1` facts, so measured coverage is 0/20 (0%)
against the required 80%.

Observed unsupported layouts:

- 17 current text-backed House e-filing tables failed with
  `parser_incomplete`. Their header uses `Name` plus `State/District`, their
  rows use optional ID/owner cells, wrapped assets, optional partial
  transaction labels, and separate filing-status/detail lines. Flattened PDF
  text does not preserve those table boundaries reliably.
- Two legacy image-only forms contain visible transaction rows but correctly
  return `pdf_scanned_unsupported` without inventing facts.
- One 13-page scanned legacy form with attached transaction schedules exceeds
  the reviewed page bound and returns `pdf_page_limit_exceeded` without
  inventing facts.

The smallest extension needed before Spec 4 continues is a deterministic,
coordinate-aware parser for the current text-backed House e-filing layout in
the Spec 3 adapter. Those 17 documents are 85% of this corpus, so OCR and wider
legacy-layout support are not required to clear the gate. The unchanged corpus
must then prove at least 16/20 transaction-bearing documents, retained
zero-row behavior, and no invented rows from the three unsupported documents.

The live runner requires the explicit `--authorized-live-read` flag and writes
only to its caller-supplied directory. It uses in-memory stores and does not
write production state, change flags, deploy, or deliver alerts.
