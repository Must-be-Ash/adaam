# Strategy packs

This directory contains reviewed, declarative strategy-pack versions. Runtime
code consumes only the generated catalog in `agent/lib`; it does not scan this
directory in production.

The first production pack is added by the IPO Filings vertical slice. The
catalog and generator intentionally support an empty production catalog before
that unit lands.
