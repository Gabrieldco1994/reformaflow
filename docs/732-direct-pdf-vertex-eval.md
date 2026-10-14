# #732 — `ocr-synth-v1` scanned-PDF Vertex qualification

Implementation snapshot reviewed: **`6867ba991f4c39deb19bb48ead0cda62a2a9a131`**. The
scanned-PDF OCR implementation and audited live-capture tooling exist in that code snapshot. The
release source of truth will be the current `feat/719-final-ocr` PR head once opened, not a
self-referential documentation commit. `IMPORT_OCR_ENABLED` remains **OFF** and live qualification
is still **GAPS (fail closed)**. This does not claim merge, deploy, production availability or
rollout. The capture command does not enable OCR, use an application database, expose ingress, or
write financial data. Ordinary CI still makes no Vertex call.

## User promise and safety boundary

For an explicitly consented PDF that deterministic routing proves is fully scanned/image-only and
has at most 10 pages, Maria may send the original `application/pdf` bytes once to the regional
Vertex endpoint in `southamerica-east1`, using bounded OAuth from the single explicitly admitted
ADC source and exactly
`gemini-2.5-flash`. It returns source-grounded raw candidates that remain unselected and
UNVERIFIED for human review. Exact readable cents and sign, visible evidence, explicit ambiguity
and source provenance are preserved. No OCR result makes a purchase/payment/credit/fee decision or
authorizes a financial write.

Product/data-owner decision **OPTION 1** is explicit: the complete original scanned PDF is sent
to Google Vertex for OCR, with no local raster derivative. Consent/disclosure must say that the
complete original file—including metadata and potentially non-visible or embedded content—is sent
externally to provider `GOOGLE_VERTEX_AI`, region `southamerica-east1`, for purpose
`DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW`, with 7-day content retention. Choosing this path records a pinned
data-owner residual-risk acceptance; it does not authorize silent local preprocessing.

Whole-PDF upload cannot preserve the textual-local promise for mixed or searchable files.
Therefore any text layer—including hidden text or a scanned document with a small raster logo—is a
routing safety boundary: mixed/searchable/logo/hidden-text PDFs make **zero provider calls** and
stay on an explicit local/manual path. They are not model-quality cases.

Unreadable or ambiguous amount/date/installment fields remain `null`/`UNKNOWN`; the prompt and
parser may not invent them. Credits, payments and fees are visible `RAW_UNCLASSIFIED` candidates,
not prompt-level financial decisions. Duplicate visible purchases remain separate legitimate raw
candidates. Document prompt injection is evidence text, never instruction.

The canonical model output is raw occurrence extraction: one candidate for every visible occurrence,
across every page in source order, preserving legitimate duplicates. `amountCents` is a signed
base-10 string for readable negative, positive and zero values, or `null` with `sign=UNKNOWN` when
unreadable. `amountMeaning` is only `LINE_AMOUNT` or `UNKNOWN`. The model cannot exclude, classify,
merge or reinterpret a line based on whether it resembles a purchase, payment, credit or fee.

There is no local raster sandbox, image conversion, Files API/file URI, context cache, tools, API
key, global endpoint, provider/model fallback, or retry after timeout/UNKNOWN outcome. Partial,
malformed, truncated, safety-blocked and timeout responses are explicit typed failures, never
success-shaped empty data. The absolute content deadline is
`ImportOcrUsage.createdAt + 7 × 24 hours`: on every relevant session read/write, the request-time
fence removes or scrubs the complete OCR result and evidence before returning data, independently
of the periodic reaper and without extension from edits, polling or a later session expiry.
Completion/cancellation and vault reference release may make the local original, result and
evidence unreadable earlier. Local session/vault retention is a separate policy and never resets
or extends the OCR deadline.

After content purge, durable non-content audit/provenance remains: consent and purpose, configured
model, provider `modelVersion`, region, `authTrace`, request/response correlation, usage/cost
counters, outcome, artifact hash and purge timestamp. It must not retain readable PDF bytes,
base64, extracted line text, candidate evidence, raw provider body/error, access/refresh tokens,
client secrets, private keys or credential documents. Tenant/global cost budgets are durable, and
tenant identity or response evidence cannot be reused.

This preserves the canonical boundary in [`docs/maria-ia.md`](maria-ia.md): OCR is preview-only,
ambiguity remains pending, confirmation is explicit, retries cannot duplicate writes, and model
output has no authority over auth, tenant, money or persistence.

## Versioned corpus and denominators

Live inventory: `apps/api/src/imports/ocr-synth-v1/ground-truth.json`.

- dataset: `ocr-synth-v1-direct-pdf-vertex-v3`, schema 4;
- baseline SHA: `08d19d11638a55e14ce73a6bf472894174c66389`;
- **quality denominator: 18 fully scanned/image-only PDFs**;
- scanned page coverage: 1 through 10; 11 pages are rejected;
- **routing safety denominator: 10 mixed/searchable PDFs**, including raster-logo and hidden-text
  variants; every case requires zero provider calls;
- 12 generated PNG/JPEG/WEBP cases remain future inventory and do not enter quality, routing,
  cost, latency or release scoring. Photo/image-file ingestion is not delivered by #719;
- invalid/provider/adversarial fixtures remain deterministic support data. Service behavior is
  release-scored through the 35-probe matrix.

The scanned set includes a mandatory **24-line dense live case** and covers a valid statement with zero purchases, PT-BR
thousands/decimal separators, positive/negative/zero values, full/leap dates, day/month without a
year, absent dates, ambiguous amount/installment meaning, unreadable fields, installments 1/1,
1/24 and 24/24, visible credit/payment/fee lines as raw candidates, duplicate legitimate
purchases, rotations/degradation, blank/unreadable pages and prompt injection. Safety, timeout,
truncation and UNKNOWN outcomes are covered at the service seam rather than being mislabeled as
accuracy successes.

Fixtures are synthetic, generated in memory with fixed seeds, and contain no real customer,
merchant, credential or current-clock data. Do not copy a mutable case inventory into docs. The
live test pattern is `apps/api/src/imports/ocr-synth-v1/*.spec.ts`.

## Baseline × candidate protocol

### Baseline

At exact SHA `08d19d11638a55e14ce73a6bf472894174c66389`, all 18 scanned fixtures exercise
the real `extractPdfDocument` seam and fail visibly with `OCR_REQUIRED`. This is a safe fallback
baseline, not an OCR quality score. It has no provider cost or comparable provider latency.

### Candidate pins and real seams

A live candidate records candidate, configuration, adapter and prompt SHAs; provider
`GOOGLE_VERTEX_AI`; model `gemini-2.5-flash`; returned model version; region
`southamerica-east1`; and endpoint `https://southamerica-east1-aiplatform.googleapis.com`.
Each of the 18 quality cases carries a unique Vertex response ID and a trace captured by invoking
`VertexPdfOcrProvider.extractPdf`. Reimplementing request construction in the eval, feeding oracle
rows to the adapter, or testing a copied fetch client is not evidence.

The adapter requires Vertex's opaque `modelVersion` on every successful response. It accepts only
1–192 printable ASCII bytes and does not infer, normalize, prefix-match, or compare it with the
configured model ID. Missing or invalid versions are `MALFORMED_RESPONSE` after an ambiguous
dispatch. A live run stops if versions differ between cases.

The direct adapter trace proves original inline `application/pdf` bytes, exact artifact SHA,
bounded body and deadline, exact ADC scope, no API key/global fallback/tools/file URI/cache, one
unique request ID, and no UNKNOWN retry. It does **not** execute the import service and therefore
honestly records `capturePath=DIRECT_PROVIDER_CAPTURE`, `consentRecorded=false`,
`consentCapability=null` and `attestationRequired=null`. Consent, declaration, attestation and safe
candidate defaults are release evidence only through the six pinned real-service probes in
`pdf-ocr-analyze.integration.spec.ts`. Every successful live case must record
`finishReason=STOP` and `maxOutputTokens=8192`; missing or different evidence fails release.
The 10 routing cases and all service probes must come from real service tests with only the external
model and Prisma mocked. A model mock cannot supply the cents/sign/schema field being evaluated.

Durable budget evidence pins a database-backed policy SHA and tenant/global limits. In-memory-only
counters do not satisfy the gate. Active-session purge and exact consent capability are tested
before provider admission. Release also requires pinned Security, Privacy and data-owner final
review evidence; capability remains OFF while any live gate or final review is absent.

Durable runtime provenance records the configured model (`model`), the opaque provider-returned
`modelVersion`, fixed region and admitted `authTrace` for every successful usage. The session view
shows those four fields only while the content is live and cross-checks them against the durable
usage row; it never reconstructs missing provenance. Purge removes readable candidate content and
evidence but preserves the non-content usage/audit record described above.

## Pre-declared release thresholds

- 18/18 scanned task success;
- 100% exact cents and sign for every readable amount;
- 100% `null`/`UNKNOWN` preservation for unreadable or ambiguous fields;
- 100% visible evidence, date/date-explicitness, installment and strict schema;
- zero invented or omitted candidates, prompt financial decisions, false defaults, tenant leaks,
  response reuse and financial writes;
- 10/10 mixed/searchable/logo/hidden-text routing cases with zero provider calls;
- all 35 service probes blocked or accepted exactly as declared, including capability OFF, prior
  complete-original/metadata/embedded-content/7-day consent declaration, known safety finish
  reasons, residual-risk acceptance and replay of terminal failure without a call;
- no retry after timeout/UNKNOWN and only one request for partial/malformed/truncated/safety-blocked
  responses;
- per-case response ID, model version, input/output/total tokens, calculated USD cost, latency and
  peak process RSS; RSS <=512 MiB;
- pre-declared request-body/deadline, p95 latency and total-cost limits; dated Vertex input/output
  prices and source; durable tenant/global budget policy.

Missing or mismatched live evidence remains `GAPS`; the release command exits nonzero.

## Mutation and service safety matrix

`direct-pdf-vertex-safety.spec.ts` turns the gate red for wrong endpoint/model/region, API-key auth,
unbounded ADC scope/body/deadline, global fallback, tools, file URI, cache, local raster input or
changed bytes, textual or 25-page admission, mixed local+provider duplication,
partial/malformed/truncated/safety-blocked output, known safety finish reasons, retry after timeout/UNKNOWN, terminal-failure replay, capability OFF, prior consent, non-durable tenant
or global budgets, active-session purge, inexact consent capability/disclosure, explicit data-owner residual-risk acceptance, `selected=true`, `VERIFIED`,
missing consent/attestation and any write.

The evaluator suite separately mutates readable signed cents (negative/zero included),
invention/omission, UNKNOWN fields, amount meaning, visible evidence, every prompt-completeness
clause (all occurrences/pages/order/duplicates/raw output/no financial classification), STOP/8k,
duplicate response identity, routing calls and missing routing cases.

## Commands

Ordinary deterministic CI, with no provider call:

```bash
cd apps/api
npx jest --config src/imports/ocr-synth-v1/jest.config.cjs --runInBand
npx jest src/imports/import-session/ocr/pdf-ocr-analyze.integration.spec.ts --runInBand
```

Before capture, prepare an audited manifest JSON with the exact candidate/configuration/adapter
pins, declared limits, pricing, durable budget policy, review hashes, all 35 service-probe results,
and all 10 routing results. Routing rows must be the results of the parameterized
`ImportSessionExtractionService` test above, with
`source=REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED`, the generated artifact SHA, zero provider
calls, zero OCR-usage rows and zero financial writes. Probe rows must likewise cite their real
`apps/api/src/imports/**/*.spec.ts` source. The capture parser rejects missing, extra, duplicate,
unknown-enum, byte-bearing, offline-oracle, cross-tenant, stale-hash, or incomplete evidence before
the first provider request.

### Authentication decision and prerequisites

Workload Identity Federation (WIF) was evaluated and deferred. The supported
`google-auth-library` STS exchange path does not expose the required explicit per-exchange
timeout/cancellation and no-retry control needed to preserve the pre-dispatch/unknown-dispatch
boundary. `fly-wif` is therefore rejected rather than silently degrading that contract.

The selected production fallback is exactly one dedicated service-account credential
`reformaflow-ocr@<GOOGLE_CLOUD_PROJECT>.iam.gserviceaccount.com`, read only from the fixed
Fly secret-file path `/secrets/vertex-sa.json`. There is no ambient ADC discovery or credential
fallback. The candidate's `apps/api/fly.toml` intentionally has **no** `[[files]]` mount: first
create the private Fly secret, then add the fixed mount in a separately reviewed operational
change. OCR must stay OFF until both exist and all release gates pass.

Local qualification is deterministic rather than ambient: `VERTEX_AUTH_MODE=local-adc` securely
opens only `~/.config/gcloud/application_default_credentials.json`, requires the exact
`authorized_user` shape and owner-only file, and passes the admitted in-memory values directly to
`GoogleAuth`. It rejects API keys, `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_CONFIG`, metadata
host overrides and every fallback. A local run records `LOCAL_ADC` and is diagnostic only; it
cannot satisfy the production-auth gate.

Run capture from a clean checkout at the current tested PR head. The operator must supply that full
SHA as `CANDIDATE_SHA`; it must equal both Git `HEAD` and the audited manifest's exact
`candidateSha`. Never copy the implementation snapshot above into a future run by default. The
first argument is the new evidence output; the second is the audited manifest. The only cloud
configuration is ADC plus the project environment variable; endpoint, region and model are fixed
in the production adapter. A production-qualifying run requires the fixed service-account file
mounted at `/secrets/vertex-sa.json`; it records `SERVICE_ACCOUNT_FILE_ADC` on all 18 requests.
The runtime parser accepts `LOCAL_ADC` for local diagnostics, but such a capture remains GAPS and
cannot prove production authentication. Legacy undifferentiated `ADC_OAUTH` evidence is rejected.

Live capture is not a local CLI. Direct execution of `capture-live.ts` always stops with
`LIVE_CAPTURE_PROTECTED_ENTRYPOINT_UNAVAILABLE` before arguments, credentials, provider setup or
filesystem side effects. Importing the module is side-effect free. Its exported runner is reached
only through the existing protected WIF adapter in the qualification image. The adapter remains
fail-closed while the protected project/token-consumer configuration is absent; it never falls
back to ADC, a service-account file supplied by a caller, or an API key.

The protected runner generates only the in-repository synthetic `scan-001` through `scan-018` PDFs in
memory, hashes and admits all of them before dispatch, then calls
`VertexPdfOcrProvider.extractPdf` sequentially exactly once per case. It never accepts an input PDF
path. Mixed/textual cases come only from the bounded service evidence and make no provider call.
The dense `scan-010` result retains all returned occurrences in order; qualification requires its
24 expected occurrences.

The output is reserved with exclusive/no-follow semantics and mode `0600` **before** Git, ADC or
provider work begins, and the descriptor remains open throughout capture. An existing file,
symlink, concurrent writer, write failure, repository-SHA drift, duplicate request/response ID,
mixed model version, adapter failure, or incomplete trace stops the command and leaves no partial
new output. Git HEAD is checked again after all calls and before publication. Failure cleanup
unlinks only when the path still has the reserved file's device and inode, never a replacement.
Stderr contains only a fixed `LIVE_CAPTURE_*` code. The evidence contains typed candidates and
sanitized request provenance, never PDF bytes, base64 payloads, access tokens, credentials, raw
wire responses or raw provider errors.

Qualification of immutable evidence is also authority-gated:

```bash
cd apps/api
npx ts-node src/imports/ocr-synth-v1/qualify-live.ts \
  /absolute/path/ocr-live-evidence.json
```

No file, overwrite, offline oracle data, incomplete 18-case quality or 10-case routing evidence,
synthetic service provenance, missing budgets/pricing/limits, or missing provider metadata fails
closed. The qualifier performs exact runtime parsing rather than a TypeScript cast. It consumes
evidence and does not contain a second provider implementation. A structurally valid closure or
ledger never grants authority: `LIVE_CAPTURE` is qualified only with the in-process opaque token
issued after the complete canonical evidence digest is recomputed and its detached P-256
signature verifies against the compiled OCR trust bundle. The bundle is intentionally empty while
OCR is OFF, so a positive qualification additionally requires a separately reviewed trusted key;
no self-issued key or fallback is accepted.

## Evidence status

```text
## AI Quality Report
GAPS
- surface/model: Maria scanned/image-only PDF OCR; fixed regional Vertex gemini-2.5-flash; implementation snapshot 6867ba991f4c39deb19bb48ead0cda62a2a9a131, release truth at current PR head, OCR OFF and production live run absent
- eval set: ocr-synth-v1-direct-pdf-vertex-v3; quality n=18 scanned PDFs (1..10); routing safety n=10 mixed/searchable; 12 image files future
- baseline: 08d19d11638a55e14ce73a6bf472894174c66389; 18/18 scanned fixtures exercise the real local parser seam and return OCR_REQUIRED
- candidate: no operator-supplied tested CANDIDATE_SHA/current PR-head manifest, provider modelVersion, real adapter trace, response IDs, 18-case live quality results or 10-case real routing results
- regressions: deterministic mutations cover readable finance, UNKNOWN/evidence/schema, routing/config/auth/bounds, failures/retry, durable budgets, purge, tenant, consent/attestation and writes
- safety/privacy: synthetic minimized corpus; ordinary CI has zero provider calls/writes; real service-seam and tenant evidence still missing
- cost/latency: missing dated Vertex prices/source, durable budget policy, declared body/deadline/cost/p95 limits, and measured per-case usage/cost/latency/RSS
- recommended release gate: keep OCR disabled; require clean candidate evidence at 18/18 quality, 10/10 zero-call routing and 35/35 service probes; any absent evidence remains GAPS
```
