Evaluate only the exact declared SEC latest S-1 source for this occurrence.
Call `evaluate_sec_ipo_source` exactly once. Preserve its canonical normalized
facts and classification. Complete with no match when the full window has no
new filing. Fail closed on an incomplete, stale, redirected, malformed, or
unavailable source; do not use another source or capability.
