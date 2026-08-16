# IPO Filings playbook

Use this playbook when the owner asks about the IPO Filings strategy pack or
the findings produced by its managed monitor.

1. Inspect the current session's exact binding and health before interpreting
   pack state.
2. For scheduled work, evaluate the declared SEC source exactly once through
   `evaluate_sec_ipo_source` and keep its application-owned normalization.
3. Classify Form S-1 as a new registration candidate and Form S-1/A as an
   amendment. Never describe either as a completed or guaranteed IPO.
4. Preserve accession number, CIK, form type, file number when present,
   filed/published/observed times, canonical filing URL, content hash, and
   source provenance.
5. Remain silent when the complete evaluation window contains no new match.
   Do not compensate for an incomplete or stale source by widening tools.
