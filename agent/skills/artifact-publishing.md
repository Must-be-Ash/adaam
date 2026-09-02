---
description: Use when the user wants an openable or shareable report, chart, graph, image, PDF, audio, video, or downloadable file.
---

# Artifact publishing

Turn a completed public-data result into the requested durable Eve artifact. The user
does not need to say “public,” ask for a link, name a publishing tool, or choose a host.
All artifact URLs currently produced by Eve are public and shareable.

## Privacy gate

Publish only public, non-account data and set `publicDataOnly: true`. Never publish
balances, holdings, portfolio analysis, account or order history, personal information,
credentials, signed URLs, private attachments, or a report that mixes those values with
public research. Keep private results in the authenticated chat because owner-private
artifact storage is not implemented.

## Choose one primary publisher

Choose the tool from the user's requested primary deliverable:

- `publish_report`: a compound report or research dossier with multiple sections.
- `publish_chart`: a chart-first deliverable such as a line, bar, pie, candlestick,
  volume, or order-book depth visualization.
- `publish_image`: an image. After generating an image, publish the image itself.
- `publish_pdf`: an existing PDF. It does not convert a report to PDF.
- `publish_audio`: a playable audio artifact.
- `publish_video`: a playable video artifact.
- `publish_file`: a downloadable CSV, JSON, text, or other non-media file.

Do not turn the requested primary media into a report that merely cites its URL. Do not
use `publish_report` for a chart-only request. Use `publish_report` for a report that
contains one or more requested chart blocks alongside other report sections.

## Reports

Use structured schema fields rather than authoring HTML or pasting a Markdown document
into one text block:

- headings belong in `heading`;
- lists belong in `bullets`;
- key figures belong in top-level metrics or a metrics block;
- comparisons belong in table blocks;
- visual data belongs in the corresponding chart block; and
- evidence belongs in `sources`, with a readable label and direct public URL.

Populate `requirements` with every element explicitly requested by the user and every
element required by the active research workflow. Choose the exact chart type after
choosing its representation. For example, a request for key stats, a candlestick chart,
a bar-based volume chart, order-book depth, a comparison table, and sources requires:

`metrics`, `candlestick-chart`, `bar-chart`, `depth-chart`, `table`, and `sources`.

External-evidence research always requires `sources`. Do not bury URLs only in prose.

Before the one allowed `publish_report` call, verify every declared requirement has a
matching structured field or block in the exact payload you are about to submit. In
particular, `table` requires a table block and each chart requirement requires a chart
block of that type. If the data is unavailable, remove only requirements the user did
not request; otherwise explain the gap before publishing instead of consuming the
one-shot validation attempt with an incomplete report.

## Charts

`publish_chart` requires actual numeric chart data in `charts`:

- line charts need named series with at least two labeled numeric points;
- bar charts need labeled numeric items;
- pie charts need at least two slices with a non-zero total;
- candlestick charts need at least two internally consistent OHLC candles; and
- depth charts need numeric bids and asks.

Collect the chart data before publishing. Labels, prose, tables, source URLs, or claims
that data was fetched are not chart data. Never invent, interpolate, or silently replace
missing values. If the requested data is unavailable, explain the gap instead of
publishing a fake or incomplete visualization.

## Remote media and files

For a request to generate an image or video, load the `agentcash` skill and use
`https://stablestudio.dev` as its known origin. Follow AgentCash discovery, schema,
quote, balance, approval, and polling steps, then pass the provider's credential-free
public media URL to `publish_image` or `publish_video`. Do not use broad AgentCash search
when this known origin fits. Never claim generation succeeded before the provider
returned the requested media.

Never substitute ASCII art, inline SVG, or another model-authored drawing for a requested
generated image unless the user explicitly asks for that format. If generation or
publication fails, report the exact safe failure and stop; do not silently change the
deliverable.

Image, PDF, audio, video, and remote file publishers ingest a credential-free,
query-free public HTTPS source URL and copy the bytes into Eve's durable public store.
Use the publisher matching the returned media type. If a paid provider completed but its
result is only an unsafe temporary URL or inline binary Eve could not retain, do not
repay or automatically retry; recover the provider's original durable result or report
the limitation.

`publish_file` accepts exactly one source URL or one small text value. Use a `.csv`,
`.json`, or `.txt` filename and matching content type for model-authored text files.
Never send SVG, image, audio, video, or PDF content to `publish_file`.

## One-shot final validation

The narrow publishers share one final validation guard. A result with
`status: "not_published"` and `retryAllowed: false` is terminal for artifact publishing
in that turn. Do not call any `publish_*` tool again in the same turn. State the missing
requirement concisely and wait for a new user turn; never repair-loop.

After `status: "published"`, reply briefly and end with the exact `artifactMarker` on its
own line. Do not rewrite it as Markdown, substitute another URL, or repeat the full
artifact in chat.
