# Strategy packs

This directory contains reviewed, declarative strategy-pack versions. Runtime
code consumes only the generated catalog in `agent/lib`; it does not scan this
directory in production.

The production catalog currently contains the IPO Filings reference vertical
and the House-only Congressional Signals research-triage vertical. Every pack
version is generated into the checked-in catalog and validated against reviewed
application capability, source, finding, presentation, and evaluation IDs.
