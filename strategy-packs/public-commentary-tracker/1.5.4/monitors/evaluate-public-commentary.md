# Evaluate configured public commentary

Call `evaluate_public_commentary_signals` exactly once. The shared capability
owns acquisition, analysis, evidence, checkpoint, finding, and alert state.

One occurrence runs the shared worker session plus one bounded interpretation
child per eligible statement. Versions 1.0.0-1.1.0 sized the per-run envelope at
12,000 input and 2,000 output tokens, below the worker session's own declared
limits, so the session could exhaust itself before committing an outcome. This
version reserves 160,000 input and 32,000 output tokens per run. Paid ceilings
are unchanged.

Versions 1.0.0-1.2.0 decided relevance by literal keyword matching before the
model saw a statement, and attributed every match to a configured asset. This
version sends each statement to a bounded classification contract instead: the
model decides whether it is material, names the market the statement is about,
and returns the implied direction. The registered policy then preserves that
direction, and selectedSymbols still filters alerts afterwards.

Version 1.3.0 pinned classification contract 1.0.0, which reserved a paid
ceiling for a call it has no tool surface to make. The occurrence's source read
consumed the whole paid envelope and the remaining classifications were refused
before anything could commit. Version 1.5.0 pinned 1.0.1, which declares no paid
allowance for that job. This version pins 1.0.2, retaining that zero paid
allowance while raising only the cumulative input-token limit from 24,000 to
40,000 so a bounded tool-repair turn can start. Version 1.5.4 pins contract
1.0.3 to qualified Gemini 3.7 Flash and preserves an applicable configured
impact-hypothesis asset symbol instead of substituting a related proxy.
