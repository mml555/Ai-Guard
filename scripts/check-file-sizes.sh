#!/usr/bin/env bash
# Enforce the backend modularity file-size rule for TypeScript sources.
set -euo pipefail

SOFT_LIMIT=250
HARD_LIMIT=650
AUTO_SPLIT_LIMIT=900

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

file_list="${TMPDIR:-/tmp}/modelgov-file-sizes.$$"
trap 'rm -f "$file_list"' EXIT

{
  git ls-files -- '*.ts' '*.tsx'
  git ls-files --others --exclude-standard -- '*.ts' '*.tsx'
} | sort -u > "$file_list"

failures=0

is_seed_file() {
  local file="$1"
  [[ "$file" == *"/seed/"* || "$file" == *"/seeds/"* ]]
}

has_exception_header() {
  local file="$1"
  head -20 "$file" | grep -q "FILE_SIZE_EXCEPTION: >650 LOC" &&
    head -20 "$file" | grep -q "TRACKING:"
}

while IFS= read -r file; do
  [[ -f "$file" ]] || continue
  is_seed_file "$file" && continue

  lines="$(wc -l < "$file" | tr -d ' ')"
  if (( lines <= HARD_LIMIT )); then
    continue
  fi

  if (( lines > AUTO_SPLIT_LIMIT )); then
    echo "error: $file has $lines LOC, above the $AUTO_SPLIT_LIMIT auto-split limit" >&2
    failures=$((failures + 1))
    continue
  fi

  if ! has_exception_header "$file"; then
    echo "error: $file has $lines LOC, above the $HARD_LIMIT hard limit and lacks FILE_SIZE_EXCEPTION/TRACKING header" >&2
    failures=$((failures + 1))
  fi
done < "$file_list"

if (( failures > 0 )); then
  echo "File-size check failed ($failures file(s)). Soft limit is $SOFT_LIMIT LOC; hard limit is $HARD_LIMIT LOC." >&2
  exit 1
fi
