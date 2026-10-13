#!/bin/bash
set -euo pipefail
umask 077

readonly INPUT=/work/input.pdf
readonly OUTPUT=/work/output
readonly MANIFEST=/work/manifest.json
readonly MAX_PAGES=10
readonly MAX_DIMENSION=4096
readonly MAX_PAGE_POINTS=14400
readonly MAX_OUTPUT_BYTES=33554432
readonly MAX_FILE_BYTES=34603008
readonly CPU_SECONDS=40
readonly CODE_MALFORMED_PDF=MALFORMED_PDF
readonly CODE_ENCRYPTED_PDF=ENCRYPTED_PDF
readonly CODE_EMBEDDED_FILE=EMBEDDED_FILE
readonly CODE_PAGE_LIMIT_EXCEEDED=PAGE_LIMIT_EXCEEDED
readonly CODE_DECOMPRESSION_LIMIT=DECOMPRESSION_LIMIT
readonly CODE_RASTER_LIMIT_EXCEEDED=RASTER_LIMIT_EXCEEDED
readonly CODE_INVALID_SANDBOX_OUTPUT=INVALID_SANDBOX_OUTPUT

fail() {
  printf '%s\n' "$1"
  exit 70
}

limited() {
  /usr/bin/prlimit \
    --as="$PDF_SANDBOX_ADDRESS_SPACE" \
    --cpu="$CPU_SECONDS" \
    --fsize="$MAX_FILE_BYTES" \
    --nofile="$PDF_SANDBOX_OPEN_FILES" \
    --nproc=32 \
    --core=0 \
    -- "$@"
}

[[ -f "$INPUT" && ! -L "$INPUT" ]] || fail "$CODE_INVALID_SANDBOX_OUTPUT"
mkdir -m 700 /work/tmp /work/output

if limited /usr/bin/qpdf --requires-password "$INPUT" >/dev/null 2>&1; then
  fail "$CODE_ENCRYPTED_PDF"
fi
limited /usr/bin/qpdf --check "$INPUT" >/dev/null 2>&1 ||
  fail "$CODE_MALFORMED_PDF"

attachments="$(limited /usr/bin/qpdf --list-attachments "$INPUT" 2>/dev/null)" ||
  fail "$CODE_MALFORMED_PDF"
[[ -z "$attachments" ]] || fail "$CODE_EMBEDDED_FILE"

info="$(limited /usr/bin/pdfinfo -box "$INPUT" 2>/dev/null)" ||
  fail "$CODE_MALFORMED_PDF"
pages="$(printf '%s\n' "$info" | /usr/bin/awk '/^Pages:[[:space:]]/ {print $2; exit}')"
[[ "$pages" =~ ^[0-9]+$ ]] || fail "$CODE_MALFORMED_PDF"
(( pages >= 1 && pages <= MAX_PAGES )) || fail "$CODE_PAGE_LIMIT_EXCEEDED"

manifest='{"version":1,"pages":['
total_output=0
total_raw=0
for ((page = 1; page <= pages; page++)); do
  page_info="$(limited /usr/bin/pdfinfo -f "$page" -l "$page" -box "$INPUT" 2>/dev/null)" ||
    fail "$CODE_MALFORMED_PDF"
  source_dimensions="$(
    printf '%s\n' "$page_info" |
      /usr/bin/sed -n \
        -e 's/^Page size:[[:space:]]*\([0-9.][0-9.]*\)[[:space:]]*x[[:space:]]*\([0-9.][0-9.]*\).*/\1 \2/p' \
        -e 's/^Page[[:space:]]*[0-9][0-9]* size:[[:space:]]*\([0-9.][0-9.]*\)[[:space:]]*x[[:space:]]*\([0-9.][0-9.]*\).*/\1 \2/p' |
      /usr/bin/head -n 1
  )"
  read -r source_width source_height <<<"$source_dimensions"
  /usr/bin/awk \
    -v w="${source_width:-0}" \
    -v h="${source_height:-0}" \
    -v max="$MAX_PAGE_POINTS" \
    'BEGIN { exit !(w > 0 && h > 0 && w <= max && h <= max) }' ||
    fail "$CODE_DECOMPRESSION_LIMIT"
  serial="$(printf '%04d' "$page")"
  raw="$OUTPUT/raw-$serial.png"
  final="$OUTPUT/page-$serial.png"
  limited /usr/bin/pdftocairo \
    -f "$page" -l "$page" -singlefile -png -r 144 -scale-to 2048 \
    "$INPUT" "${raw%.png}" >/dev/null 2>&1 ||
    fail "$CODE_DECOMPRESSION_LIMIT"
  [[ -f "$raw" && ! -L "$raw" ]] || fail "$CODE_INVALID_SANDBOX_OUTPUT"
  limited /usr/bin/pngcrush -q -rem alla "$raw" "$final" >/dev/null 2>&1 ||
    fail "$CODE_DECOMPRESSION_LIMIT"
  rm -f -- "$raw"
  limited /usr/bin/pngcheck -q "$final" >/dev/null 2>&1 ||
    fail "$CODE_INVALID_SANDBOX_OUTPUT"
  dimensions="$(
    /usr/bin/pngcheck -v "$final" 2>/dev/null |
      /usr/bin/sed -n 's/.* \([0-9][0-9]*\) x \([0-9][0-9]*\) image.*/\1 \2/p' |
      /usr/bin/head -n 1
  )"
  read -r width height <<<"$dimensions"
  [[ "$width" =~ ^[0-9]+$ && "$height" =~ ^[0-9]+$ ]] ||
    fail "$CODE_INVALID_SANDBOX_OUTPUT"
  (( width <= MAX_DIMENSION && height <= MAX_DIMENSION )) ||
    fail "$CODE_RASTER_LIMIT_EXCEEDED"
  total_raw=$((total_raw + width * height * 4))
  (( total_raw <= 134217728 )) || fail "$CODE_RASTER_LIMIT_EXCEEDED"
  size="$(/usr/bin/stat -c %s "$final")"
  total_output=$((total_output + size))
  (( total_output <= MAX_OUTPUT_BYTES )) || fail "$CODE_RASTER_LIMIT_EXCEEDED"
  (( page == 1 )) || manifest+=','
  manifest+="{\"pageNumber\":$page,\"file\":\"page-$serial.png\",\"width\":$width,\"height\":$height}"
done
manifest+=']}'
printf '%s' "$manifest" >"$MANIFEST"
