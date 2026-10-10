# Maria CSV conversational intake — RED checkpoint

- Base: `dc13523246bc66671832734b7ac55d524b3feac3`
- Time zone: `TZ=UTC`
- npm: `11.6.2`
- Command:

  ```bash
  cd apps/web
  TZ=UTC npx playwright test \
    --config=e2e/maria-csv-import-real/playwright.config.ts \
    --workers=1
  ```

- Result: **1 failed / 1 total**, after real signup, creation of one PESSOAL
  and one REFORMA project, real authenticated API reads, card fixture creation,
  isolated-Prisma snapshot, and Maria page load.
- Intended RED:

  ```text
  Locator: getByLabel('Anexar CSV da fatura')
  Expected: visible
  Error: element(s) not found
  apps/web/e2e/maria-csv-import.real.spec.ts:358
  ```

This is the missing composer attachment intake from the architecture contract,
not a fixture, authentication, API boot, database, vault, port, or browser
setup failure.

## Isolation evidence

- Preflight requires ports `43241` and `43242` to be unowned.
- During the run, the test requires `lsof` to identify the API child on
  `127.0.0.1:43241` and a Node web listener on `127.0.0.1:43242`.
- Latest retained real-Prisma lsof gate:
  `.agents/attachment-http-evidence/database-PUA6iK/connected-before-seed-db-files.json`.
- The gate observed only:
  `.agents/attachment-qa/isolated-db-rHtB3e/test.db`.
- Its `failure` field is `null`; no allowed or observed path names `dev.db`.
- Dedicated private vault:
  `.agents/attachment-qa/isolated-db-rHtB3e/private-vault-pu51kz/vault`.
- Post-run probes returned no listeners on either dedicated port and no open
  handle for `/Users/gabrielbarbosa/reformaflow/prisma/dev.db`.
- macOS cannot provide Linux `/proc/fdinfo`; the fixture replaces only that
  lock-proof decision. Linux release qualification remains a separate required
  gate and must run without the seam.

## Frozen financial baseline

Recovery is blocked rather than approximated. See
`financial-baseline-recovery.json`; no successful exact 210/210 financial
manifest/command exists in the retained candidate evidence searched.
