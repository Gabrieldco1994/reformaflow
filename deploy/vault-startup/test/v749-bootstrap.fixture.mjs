import { spawnSync } from "node:child_process";

function sqlText(value) {
  return "char(" + [...Buffer.from(String(value), "utf8")].join(",") + ")";
}

function run(database, sql, sqliteBinary) {
  const result = spawnSync(sqliteBinary, [database], {
    encoding: "utf8",
    input: sql,
  });
  if (result.status !== 0) throw new Error("fixture sqlite failure");
  return result.stdout.trim();
}

/**
 * Deterministic model of v749 ensureBootstrapAdmin. It contains only the
 * decision relevant to compatibility: absent ADMIN variables skips the user
 * write; a complete synthetic pair inserts the missing administrator.
 */
export function simulateV749Bootstrap({
  database,
  env,
  now = 1791927101854,
  sqliteBinary = "sqlite3",
}) {
  let username = env.ADMIN_USERNAME;
  const password = env.ADMIN_PASSWORD;
  if (!username && env.ADMIN_EMAIL) username = env.ADMIN_EMAIL.split("@")[0];
  const tenantId = run(
    database,
    "SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1;",
    sqliteBinary,
  );
  if (!tenantId) throw new Error("fixture requires an existing tenant");
  if (!username || !password) return { inserted: false };
  const normalized = username.toLowerCase().trim();
  const existing = run(
    database,
    "SELECT count(*) FROM users WHERE tenant_id=" +
      sqlText(tenantId) +
      " AND username=" +
      sqlText(normalized) +
      ";",
    sqliteBinary,
  );
  if (existing !== "0") return { inserted: false };
  run(
    database,
    "INSERT INTO users (id, tenant_id, username, email, name, role, password_hash, allowed_modules, created_at, updated_at) VALUES (" +
      sqlText("fixture-v749-created-user") +
      "," +
      sqlText(tenantId) +
      "," +
      sqlText(normalized) +
      ",NULL," +
      sqlText("Administrador") +
      "," +
      sqlText("ADMIN") +
      "," +
      sqlText("synthetic-bcrypt-shape") +
      "," +
      sqlText("[]") +
      "," +
      Number(now) +
      "," +
      Number(now) +
      " );",
    sqliteBinary,
  );
  return { inserted: true };
}
