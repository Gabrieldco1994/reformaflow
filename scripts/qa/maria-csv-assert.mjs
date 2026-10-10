#!/usr/bin/env node
/**
 * Read-only assertions for an isolated Maria CSV QA database (never dev.db).
 * node scripts/qa/maria-csv-assert.mjs pre-confirm --db "$RUNNER_TEMP/qa.db" --vault "$RUNNER_TEMP/vault"
 * node scripts/qa/maria-csv-assert.mjs post-confirm --db "$RUNNER_TEMP/qa.db" --selected-count 2 --session <id>
 * Optional: --selected-ids <comma-separated receipt line IDs>, --purge-wait-ms 30000.
 * With no selection flag, post-confirm expects every purchase in expected.json.
 * --selected-ids contains receipt line IDs, not observation or expense IDs.
 * --session must identify the original session; omit only when discovery is unambiguous.
 * Requires sqlite3 CLI and an existing DB under RUNNER_TEMP/TMPDIR/system tmp.
 * Use a dedicated QA account/project with no unrelated concurrent financial writes.
 * Fixture oracle: five purchases / 50524 cents; first two / 19134 cents;
 * Pagamento de fatura (-12000 cents) is ignored. All data is synthetic.
 * Local proofs (from repo root):
 * node apps/web/e2e-qa/fixtures/verify-fixtures.mjs
 * node apps/web/e2e-qa/fixtures/maria-csv-assert.selftest.mjs
 * CSV needs guided TOTAL_PURCHASE/count1, invoice 2026-11, first due 2026-11-10,
 * create-new/personal/no allocation declarations. Live Maria may require an LLM.
 * --vault is an isolated vault root; omit it for DB-only checks. Raw-byte deletion
 * is asynchronous; an unexpired live continuation may legitimately retain bytes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const fixtureDir = fileURLToPath(
  new URL("../../apps/web/e2e-qa/fixtures/", import.meta.url),
);
const expected = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "expected.json"), "utf8"),
);
const fixture = fs.readFileSync(path.join(fixtureDir, "card-invoice.csv"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtureHash = sha256(fixture);
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const terminal = new Set(["APPLIED", "CANCELLED", "EXPIRED"]);
const instant = (value) => {
  const result = typeof value === "number" ? value : Date.parse(value);
  assert(Number.isFinite(result), "Invalid database timestamp");
  return result;
};
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

function safePath(input, directory = false) {
  assert(input, "Missing --db (or --vault) path");
  const requested = path.resolve(input);
  assert(
    !requested.split(path.sep).some((part) => part.toLowerCase() === "dev.db"),
    "Refusing dev.db",
  );
  const resolved = fs.realpathSync(requested);
  assert(
    !resolved.split(path.sep).some((part) => part.toLowerCase() === "dev.db"),
    "Refusing symlink to dev.db",
  );
  const roots = [
    process.env.RUNNER_TEMP,
    process.env.TMPDIR,
    "/tmp",
    "/var/tmp",
  ]
    .filter(Boolean)
    .filter((root) => fs.existsSync(root))
    .map((root) => fs.realpathSync(root));
  assert(
    roots.some((root) => inside(root, requested)) &&
      roots.some((root) => inside(root, resolved)),
    "QA paths must stay inside RUNNER_TEMP, TMPDIR or tmp, including symlink resolution",
  );
  const stat = fs.statSync(resolved);
  assert(
    directory ? stat.isDirectory() : stat.isFile(),
    "Expected an existing QA database/file or vault directory",
  );
  return resolved;
}

function options(argv) {
  const [phase, ...rest] = argv;
  assert(
    ["pre-confirm", "post-confirm", "fk"].includes(phase),
    "Phase must be pre-confirm, post-confirm or fk",
  );
  const allowed = new Set([
    "--db",
    "--vault",
    "--session",
    "--selected-count",
    "--selected-ids",
    "--purge-wait-ms",
  ]);
  const args = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    assert(
      allowed.has(flag) &&
        rest[index + 1] &&
        !rest[index + 1].startsWith("--") &&
        !(flag in args),
      `Invalid option ${flag}`,
    );
    args[flag] = rest[index + 1];
  }
  const selectedIds = args["--selected-ids"]?.split(",");
  if (selectedIds) {
    assert(
      selectedIds.every((id) => id.trim() === id && id.length > 0),
      "Invalid selected line IDs",
    );
    assert.equal(
      new Set(selectedIds).size,
      selectedIds.length,
      "Duplicate selected line IDs",
    );
  }
  const count = Number(
    args["--selected-count"] ??
      selectedIds?.length ??
      expected.selectablePurchaseCount,
  );
  assert(
    Number.isSafeInteger(count) &&
      count > 0 &&
      count <= expected.selectablePurchaseCount,
    "Invalid selected count",
  );
  if (selectedIds)
    assert.equal(count, selectedIds.length, "Selected IDs/count disagree");
  const purgeWaitMs = Number(args["--purge-wait-ms"] ?? 30000);
  assert(
    Number.isSafeInteger(purgeWaitMs) &&
      purgeWaitMs >= 0 &&
      purgeWaitMs <= 300000,
    "Invalid purge wait (0..300000ms)",
  );
  return {
    phase,
    db: safePath(args["--db"]),
    vault: args["--vault"] ? safePath(args["--vault"], true) : null,
    sessionId: args["--session"],
    selectedIds,
    count,
    purgeWaitMs,
  };
}

function query(db, sql) {
  const result = spawnSync(
    "sqlite3",
    ["-readonly", "-json", "-cmd", ".timeout 5000", db, sql],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `sqlite3 failed: ${result.stderr}`);
  return JSON.parse(result.stdout || "[]");
}

function findSession(config) {
  const discovery =
    config.phase === "post-confirm"
      ? `s.state='APPLIED' AND json_valid(s.receipt_json) AND EXISTS (
        SELECT 1 FROM json_each(s.receipt_json, '$.snapshot.lines') line
        WHERE json_extract(line.value, '$.titulo') IN (${expected.purchases.map((p) => literal(p.title)).join(",")})
      )`
      : `EXISTS (
        SELECT 1 FROM import_session_artifacts r LEFT JOIN import_artifacts a ON a.id=r.artifact_id
        WHERE r.session_id=s.id AND r.position=0 AND r.declared_bytes=${fixture.length}
        AND (a.document_sha256=${literal(fixtureHash)} OR r.file_name='card-invoice.csv')
      ) AND (SELECT COUNT(*) FROM import_session_artifacts r WHERE r.session_id=s.id)=2`;
  const scope = config.sessionId
    ? `s.id=${literal(config.sessionId)}`
    : discovery;
  const sessions = query(
    config.db,
    `SELECT s.id, s.tenant_id, s.owner_user_id, s.owner_project_id,
    s.state, s.created_at, s.draft_json, s.receipt_json FROM import_sessions s WHERE ${scope}`,
  );
  assert.equal(
    sessions.length,
    1,
    "Expected exactly one QA import session; pass --session to disambiguate",
  );
  return sessions[0];
}

function financialRows(config, session) {
  const expenses = query(
    config.db,
    `SELECT id, titulo, valor_total, created_at, deleted_at FROM expenses
    WHERE tenant_id=${literal(session.tenant_id)} AND created_by_user_id=${literal(session.owner_user_id)}`,
  ).filter((row) => instant(row.created_at) >= instant(session.created_at));
  const cashFlows = query(
    config.db,
    `SELECT id, expense_id, created_at FROM cash_flow_entries
    WHERE tenant_id=${literal(session.tenant_id)} AND project_id=${literal(session.owner_project_id)}`,
  ).filter((row) => instant(row.created_at) >= instant(session.created_at));
  return { expenses, cashFlows };
}

function attachments(config, session) {
  return query(
    config.db,
    `SELECT id, artifact_id, position, file_name, state, released_at, reserved_bytes,
    temporary_storage_key FROM import_session_artifacts WHERE session_id=${literal(session.id)} ORDER BY position`,
  );
}

function assertDuplicate(config, session) {
  const refs = attachments(config, session);
  const continuationId = session.receipt_json
    ? JSON.parse(session.receipt_json).continuationSessionId
    : null;
  let transferredRefs = [];
  if (continuationId) {
    const continuation = query(
      config.db,
      `SELECT id, tenant_id, owner_user_id, owner_project_id, draft_json
      FROM import_sessions WHERE id=${literal(continuationId)}`,
    );
    assert.equal(
      continuation.length,
      1,
      "Receipt continuation session missing",
    );
    for (const key of ["tenant_id", "owner_user_id", "owner_project_id"]) {
      assert.equal(
        continuation[0][key],
        session[key],
        "Continuation scope mismatch",
      );
    }
    transferredRefs = attachments(config, continuation[0]);
    const pending = JSON.parse(continuation[0].draft_json).scope
      ?.pendingAttachmentIds;
    assert(Array.isArray(pending), "Missing continuation pendingAttachmentIds");
    assert(
      !pending.includes(refs.find((ref) => ref.position === 1)?.id),
      "Duplicate pending in continuation",
    );
  }
  assert.equal(
    refs.length + transferredRefs.length,
    2,
    "QA scope must contain original and duplicate references (including transferred original)",
  );
  const duplicate = refs.find((ref) => ref.position === 1);
  assert(
    duplicate,
    "Duplicate attachment reference missing from original session",
  );
  // Completed retention scrubs original filenames to "document"; position is durable.
  assert(
    ["card-invoice-copy.csv", "document"].includes(duplicate.file_name),
    "Unexpected duplicate attachment",
  );
  assert.equal(
    duplicate.state,
    "RELEASED",
    "Duplicate attachment must be RELEASED",
  );
  assert(duplicate.released_at !== null, "Duplicate release timestamp missing");
  assert.equal(duplicate.reserved_bytes, 0, "Duplicate quota was not released");
  assert.equal(
    duplicate.artifact_id,
    null,
    "Duplicate must not bind the canonical artifact",
  );
  const pending = JSON.parse(session.draft_json).scope?.pendingAttachmentIds;
  assert(Array.isArray(pending), "Missing pendingAttachmentIds");
  assert(
    !pending.includes(duplicate.id),
    "Duplicate remains in pendingAttachmentIds",
  );
  return refs;
}

function rawFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const filename = path.join(current, entry.name);
    assert(!entry.isSymbolicLink(), "Vault must not contain symlinks");
    if (entry.isDirectory()) files.push(...rawFiles(root, filename));
    else {
      assert(entry.isFile(), "Unexpected vault node");
      if (filename !== path.join(root, ".lock")) files.push(filename);
    }
  }
  return files;
}

async function checkVault(config, session) {
  if (!config.vault)
    return {
      checked: false,
      note: "DB-only; raw-byte retention was not checked",
    };
  const deadline = Date.now() + config.purgeWaitMs;
  for (;;) {
    try {
      const files = rawFiles(config.vault);
      assert(files.length <= 1, "Vault retains duplicate raw bytes");
      for (const file of files) {
        assert.equal(
          fs.statSync(file).size,
          fixture.length,
          "Unexpected vault byte length",
        );
        assert.equal(
          sha256(fs.readFileSync(file)),
          fixtureHash,
          "Vault bytes differ from synthetic fixture",
        );
      }
      if (config.phase === "pre-confirm")
        return { checked: true, rawFileCount: files.length };
      const liveRefs = query(
        config.db,
        `SELECT r.id, r.session_id, s.state, s.expires_at FROM import_session_artifacts r
        JOIN import_artifacts a ON a.id=r.artifact_id JOIN import_sessions s ON s.id=r.session_id
        WHERE a.document_sha256=${literal(fixtureHash)} AND a.tenant_id=${literal(session.tenant_id)}
        AND a.owner_project_id=${literal(session.owner_project_id)} AND r.state!='RELEASED'`,
      );
      for (const ref of liveRefs) {
        assert(
          !terminal.has(ref.state) && instant(ref.expires_at) > Date.now(),
          "Unauthorized/expired retained reference",
        );
      }
      if (liveRefs.length > 0)
        return {
          checked: true,
          rawFileCount: files.length,
          retainedByLiveSessionIds: [
            ...new Set(liveRefs.map((ref) => ref.session_id)),
          ],
        };
      assert.equal(
        files.length,
        0,
        "Unreferenced raw CSV still present; wait for asynchronous purger",
      );
      const artifacts = query(
        config.db,
        `SELECT storage_key FROM import_artifacts WHERE document_sha256=${literal(fixtureHash)}
        AND tenant_id=${literal(session.tenant_id)} AND owner_project_id=${literal(session.owner_project_id)}`,
      );
      assert(
        artifacts.every((row) => row.storage_key === null),
        "Unreferenced artifact still points to raw storage",
      );
      return { checked: true, rawFileCount: 0, retainedByLiveSessionIds: [] };
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(Math.min(250, deadline - Date.now()));
    }
  }
}

function checkReceipt(config, session, rows) {
  assert.equal(
    session.state,
    "APPLIED",
    "Confirmation must have reached APPLIED",
  );
  assert(
    session.receipt_json,
    "Applied import batch receipt missing (not a financial Receipt/recebimento)",
  );
  const receipt = JSON.parse(session.receipt_json);
  assert.equal(receipt.version, 1, "Unexpected receipt protocol");
  assert.equal(
    receipt.sessionId,
    session.id,
    "Receipt belongs to another session",
  );
  assert.equal(
    receipt.items?.length,
    config.count,
    "Receipt selection count mismatch",
  );
  assert.equal(
    receipt.snapshot?.lines?.length,
    config.count,
    "Receipt snapshot missing/mismatched",
  );
  assert.equal(
    receipt.snapshot.bankCashDeltaCents,
    0,
    "Card purchases must not debit bank cash",
  );
  assert.equal(
    rows.expenses.length,
    config.count,
    "Unexpected QA expense count (includes soft-deleted duplicates)",
  );
  assert(
    rows.expenses.every((row) => row.deleted_at === null),
    "Selected expense was soft-deleted",
  );
  const expenseIds = receipt.items.map((item) => {
    assert.equal(
      item.outcome,
      "CREATED",
      "Synthetic fresh purchases must be CREATED",
    );
    assert.deepEqual(
      item.targetExpenseIds,
      [],
      "Fixture has no cross-project allocations",
    );
    return item.sourceExpenseId;
  });
  assert.equal(
    new Set(expenseIds).size,
    config.count,
    "Duplicate expense IDs in receipt",
  );
  assert.deepEqual(
    [...expenseIds].sort(),
    rows.expenses.map((row) => row.id).sort(),
    "Expenses differ from receipt",
  );
  const lineIds = receipt.items.map((item) => item.lineId);
  assert.equal(
    new Set(lineIds).size,
    config.count,
    "Duplicate receipt line IDs",
  );
  if (config.selectedIds)
    assert.deepEqual(
      [...lineIds].sort(),
      [...config.selectedIds].sort(),
      "Selected receipt line IDs differ",
    );
  const titles = [];
  for (const expense of rows.expenses) {
    const purchase = expected.purchases.find(
      (item) => item.title === expense.titulo,
    );
    assert(purchase, `Unexpected expense title: ${expense.titulo}`);
    assert.equal(
      expense.valor_total,
      purchase.amountCents,
      "Expense amount differs from fixture",
    );
    titles.push(expense.titulo);
    const item = receipt.items.find(
      (item) => item.sourceExpenseId === expense.id,
    );
    const snapshot = receipt.snapshot.lines.find(
      (line) => line.lineId === item.lineId,
    );
    assert(snapshot, "Missing selected line snapshot");
    assert.equal(snapshot.titulo, purchase.title, "Receipt title differs");
    assert.equal(
      snapshot.totalCents,
      purchase.amountCents,
      "Receipt cents differ",
    );
  }
  assert.equal(
    new Set(titles).size,
    config.count,
    "Duplicate fixture purchase imported",
  );
  const total = rows.expenses.reduce((sum, row) => sum + row.valor_total, 0);
  assert.equal(
    receipt.snapshot.createdEconomicTotalCents,
    total,
    "Receipt economic total differs",
  );
  const cashIds = receipt.items.flatMap((item) => item.cashFlowEntryIds);
  assert.equal(
    new Set(cashIds).size,
    cashIds.length,
    "Duplicate cash flow receipt IDs",
  );
  assert.deepEqual(
    [...cashIds].sort(),
    rows.cashFlows.map((row) => row.id).sort(),
    "Unexpected cash-flow side effect",
  );
  assert(
    rows.cashFlows.every((row) => expenseIds.includes(row.expense_id)),
    "Cash flow linked to an unexpected expense",
  );
  return {
    expenseCount: rows.expenses.length,
    totalCents: total,
    receiptLineIds: lineIds,
    continuationSessionId: receipt.continuationSessionId ?? null,
  };
}

try {
  const config = options(process.argv.slice(2));
  assert.deepEqual(
    query(config.db, "PRAGMA foreign_key_check;"),
    [],
    "Foreign key violations",
  );
  let result = { phase: config.phase, foreignKeys: "PASS" };
  if (config.phase !== "fk") {
    const session = findSession(config);
    assertDuplicate(config, session);
    const rows = financialRows(config, session);
    if (config.phase === "pre-confirm") {
      assert(
        !terminal.has(session.state) && session.state !== "CONFIRMED",
        "Not a pre-confirm session",
      );
      assert.equal(
        session.receipt_json,
        null,
        "Receipt exists before confirmation",
      );
      assert.equal(
        rows.expenses.length,
        0,
        "Upload/analysis created financial expenses",
      );
      assert.equal(
        rows.cashFlows.length,
        0,
        "Upload/analysis created cash-flow entries",
      );
      result = {
        ...result,
        sessionId: session.id,
        expenseCount: 0,
        cashFlowCount: 0,
      };
    } else
      result = {
        ...result,
        sessionId: session.id,
        ...checkReceipt(config, session, rows),
      };
    result.vault = await checkVault(config, session);
  }
  console.log(JSON.stringify({ status: "PASS", ...result }, null, 2));
} catch (error) {
  console.error(`Maria CSV QA assertion FAILED: ${error.message}`);
  process.exitCode = 1;
}
