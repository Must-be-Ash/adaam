# House feasibility corpus

This corpus is the Sprint 0 feasibility gate, not a historical archive. Its
checked-in PDFs are sanitized, fixed layout derivatives of the official
House Clerk Periodic Transaction Report form and yearly financial-disclosure
index. The table headings, owner/asset/type/date/notification/amount/capital-
gains columns, amendment marker, continuation-page shape, and no-transaction
language mirror the public form while names, document IDs, and securities are
fictional.

The older `baseline-index.xml`, `one-new-index.xml`, `valid-ptr.txt`, and
`partial-ptr.txt` files are retained as small parser-development seeds. They do
not satisfy the feasibility gate; `real-layout/corpus.json` is the authoritative
gate corpus.

V1 support boundary:

- supported: the official yearly ZIP with one exact `{YEAR}FD.xml` entry;
- supported: text-layer PTR PDFs with the official header/table shape, including
  one row, multiple rows, continuation pages, amendments, and explicit
  no-transaction filings;
- partial: text PDFs whose layout does not establish the official columns or a
  complete row;
- unsupported: image-only/scanned PDFs;
- terminal failure: malformed ZIP/PDF containers or bounded-resource failures;
- excluded: OCR, model extraction, arbitrary archives/PDFs, and generic document
  conversion.

The HTML/SVG sources are kept beside the generated PDFs so the sanitized layout
and absence of hidden text remain auditable. `scripts/generate-house-feasibility-fixtures.sh`
rebuilds the binary ZIP/PDF fixtures with local system tools; normal verification
reads the checked-in binaries and does not regenerate them.
