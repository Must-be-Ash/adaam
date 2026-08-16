#!/bin/sh
set -eu

fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")/fixtures/public-source-adapters/house/real-layout" && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

for source in ptr-single-row ptr-multi-page-amended ptr-multi-page-amended-corrected ptr-multi-page-amended-row-removed ptr-no-transactions ptr-ambiguous; do
  soffice --headless --convert-to pdf --outdir "$work_dir" "$fixture_dir/$source.html" >/dev/null
  mv "$work_dir/$source.pdf" "$fixture_dir/$source.pdf"
done

soffice --headless --convert-to pdf --outdir "$work_dir" "$fixture_dir/ptr-scanned.svg" >/dev/null
mv "$work_dir/ptr-scanned.pdf" "$fixture_dir/ptr-scanned.pdf"

cp "$fixture_dir/2026FD.xml" "$work_dir/2026FD.xml"
(cd "$work_dir" && zip -q -X "$fixture_dir/2026FD.zip" 2026FD.xml)
