# #719 — `ocr-synth-v1` evaluation contract

Status: **test/eval-only; GAPS for release**. This document does not enable OCR, select a vendor,
call a provider, authorize a tool, or write financial data. It is linked only to
[#719](https://github.com/Gabrieldco1994/reformaflow/issues/719).

## User promise and safety boundary

For OCR-enabled imports, Maria may produce a source-grounded preview for the user to review. It
must preserve exact cents and sign, preserve whether a date was explicit, preserve installments
and page/region provenance, and expose unreadable, partial, timeout, provider, or schema failures.
It must not invent missing facts, treat empty/partial output as success, reuse evidence across
tenants, or perform a financial write. Candidates remain unverified and unselected until the
separate human-attestation and normal confirmation flows exist.

The deterministic corpus and evaluator in this PR test that boundary only. They do not prove
consent v2, vendor/DPA/retention/training/region approval, vault readiness, OS sandboxing,
authorization, human attestation, rollout, or production runtime behavior.

## Versioned eval set

Canonical literals live in
`apps/api/src/imports/ocr-synth-v1/ground-truth.json` (`datasetVersion=ocr-synth-v1`, 52 cases):

| Partition                   |                      Count |                  Release slice |
| --------------------------- | -------------------------: | -----------------------------: |
| scanned PDFs                |                         18 |                             18 |
| mixed text/raster PDFs      |                         10 |                             10 |
| images                      | 12 (4 PNG, 4 JPEG, 4 WEBP) |         reserved for full #719 |
| invalid admission           |                          6 |           typed negative paths |
| provider/tenant/adversarial |                          6 | typed negative/isolation paths |
| **Total**                   |                     **52** |      **28 scanned/mixed PDFs** |

The corpus covers page counts and page markers (including 1/1, 1/24, 24/24), 0/90/180/270
rotation, blur, contrast, seeded noise, compression, PT-BR decimal/thousands separators, signed
and zero values, explicit leap dates, yearless and absent dates, installments 1/1, 1/24 and 24/24,
decorative raster logos, prompt-injection text, blank/unreadable pages, malformed/empty/truncated
provider responses, timeout, and identical artifact bytes in two synthetic tenants. Names and
values are stable synthetic literals; there are no brands, real records, Faker, or wall-clock
inputs.

Binaries are generated in memory by
`apps/api/src/imports/ocr-synth-v1/fixture-generator.ts`. The small native canvas dependency is
already pinned transitively by the existing `pdf-parse` lock entry. No generated image/PDF is
checked in. The generator uses fixed dimensions, fixed PDF object ordering, fixed compression,
and seeded pixel noise. Corpus integrity checks also prove repeat generation for each media class
and byte identity for the cross-tenant pair.

Do not duplicate a mutable case list in docs. The live inventory is the JSON above and the test
pattern is `apps/api/src/imports/ocr-synth-v1/*.spec.ts`.

## Pre-declared rubric and thresholds

The evaluator at `apps/api/src/imports/ocr-synth-v1/evaluator.ts` compares every case and source
region. Release thresholds are:

- 100% task success and exact normalized cents, sign, date, date explicitness, installment, schema,
  region order, and source provenance;
- zero invented rows, omitted rows, cross-tenant reuse/leaks, and financial writes;
- all admission/provider negatives are typed errors; success-shaped empty data is forbidden;
- peak RSS at or below 512 MiB;
- complete provider/model/version, candidate/configuration/prompt SHAs, per-case request IDs,
  latency, peak RSS, token usage and USD cost evidence;
- p95 latency and total-cost limits must be declared against an identified live baseline before a
  run. No latency or cost SLO is invented by this test-only change.

Mutation tests must and do turn the evaluator red for an invented row, omitted row, wrong sign,
wrong date, wrong installment, cross-tenant request reuse, reordered region, missing region, and
missing cost metadata.

## Baseline × candidate protocol

- Baseline SHA: `dea9300360418ceb04e8ffc06a3285b83201a69d`.
- Baseline behavior: the 28-PDF raster slice is exercised against the current
  `extractPdfDocument` adapter and every case is rejected as `OCR_REQUIRED`; image OCR is not an
  admitted Maria capability. This is a safety fallback, not an OCR-accuracy score.
- Candidate: **not supplied in this PR**. Provider/model/version/configuration/prompt SHA are null.
- Offline oracle: validates corpus, parser-independent rubric, report shape, and mutations only. It
  must never be presented as model quality evidence.
- Live capture: a future #719 implementation must produce all 52 typed predictions from real
  service responses, with only the external model and Prisma mocked where appropriate. It must not
  substitute expected rows for the field being evaluated.

`npm --workspace @reformaflow/api run ocr-synth:ci` is CI-fast and offline. It performs no network,
provider, database, secret, or production-code call.

`npm --workspace @reformaflow/api run ocr-synth:release -- <live-evidence.json>` is release-only. It
reads a captured JSON input, emits a report conforming to
`apps/api/src/imports/ocr-synth-v1/report.schema.json`, and exits nonzero unless all functional and
live-evidence gates pass. The harness deliberately contains no provider client and consumes no
secret. Missing evidence remains visible rather than becoming a success-shaped empty result.

## Current evidence

```text
## AI Quality Report
GAPS
- surface/model: Maria OCR import; no candidate provider/model/prompt is configured or called
- eval set: ocr-synth-v1; 52 total; scanned PDF 18, mixed PDF 10, PNG 4, JPEG 4, WEBP 4, invalid admission 6, provider/tenant/adversarial 6; PDF gate n=28
- baseline: dea9300360418ceb04e8ffc06a3285b83201a69d; OCR_REQUIRED for raster PDF slice; images not admitted
- candidate: absent; offline oracle is evaluator self-test only and is not model evidence
- regressions: mutation suite rejects invention, omission, sign/date/installment drift, tenant reuse, region drift, and missing cost
- safety/privacy: synthetic sanitized literals; no brands/real data/Faker/current date; zero writes/provider calls/secrets; confirmation/attestation/runtime isolation remain unproved
- cost/latency: null placeholders by design; release gate fails until complete live measurements and declared limits are supplied
- recommended release gate: keep IMPORT_OCR_ENABLED false; require all 52 live cases and 28-PDF slice at exact thresholds, typed failures, tenant isolation, <=512 MiB RSS, declared latency/cost limits, and all #719 consent/vendor/vault/sandbox/human-confirmation gates
```
