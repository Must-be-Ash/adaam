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
