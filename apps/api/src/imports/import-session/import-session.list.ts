import { Prisma } from "@prisma/client";
import { ImportSessionState, ProjectType } from "@reformaflow/domain";
import type { ListScopeParams } from "./import-session.auth";
import type {
  ImportListFilter,
  ImportListPosition,
} from "./import-session.cursor";
import type { SummaryColumns } from "./import-session.projection";

/** Fixed page size; the query asks for one more row to know whether a next page exists. */
export const IMPORT_LIST_PAGE_SIZE = 25;

const TERMINAL_STATES = [
  ImportSessionState.APPLIED,
  ImportSessionState.CANCELLED,
  ImportSessionState.EXPIRED,
];

export interface ListedRow {
  readonly columns: SummaryColumns;
  readonly position: ImportListPosition;
}

interface RawRow {
  id: string;
  state: string;
  revision: bigint | number;
  card_id: string;
  owner_project_id: string;
  created_ms: bigint | number;
  expires_ms: bigint | number;
  closed_ms: bigint | number | null;
  has_confirmation: bigint | number;
  receipt_json: string | null;
}

const num = (value: bigint | number): number => Number(value);

/**
 * Visible rows of ONE owner, newest first, `PAGE_SIZE + 1` of them. Visibility (tenant, owner,
 * active PESSOAL anchor, active exact card, current card-module grant and, for applied receipts,
 * ALL participant projects under the expense module) is decided IN SQL, before the LIMIT: no
 * access filter runs on the page afterwards. Raw SQL does not go through the soft-delete
 * middleware, so `deleted_at IS NULL` is explicit everywhere. Read-only statement.
 * Temporal columns are INTEGER epoch ms (Prisma's SQLite storage, verified by probe), read back
 * through CAST and compared against bound `Date` values.
 */
export async function queryVisibleSessions(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  scope: {
    tenantId: string;
    userId: string;
    filter: ImportListFilter;
    now: Date;
    grants: ListScopeParams;
    after: ImportListPosition | null;
  },
): Promise<ListedRow[]> {
  const applied = scope.filter === "applied";
  const sortColumn = Prisma.raw(applied ? "s.closed_at" : "s.created_at");
  const { grants } = scope;
  const stateFilter = applied
    ? Prisma.sql`s.state = 'APPLIED'`
    : Prisma.sql`s.state NOT IN (${Prisma.join(TERMINAL_STATES)}) AND s.expires_at > ${scope.now}`;
  const receiptFilter = applied
    ? Prisma.sql`AND CASE
        WHEN NOT json_valid(s.receipt_json) THEN 1
        WHEN json_type(s.receipt_json, '$.snapshot.participantProjectIds') IS NOT 'array' THEN 1
        WHEN EXISTS (
          SELECT 1 FROM json_each(s.receipt_json, '$.snapshot.participantProjectIds') q
          WHERE q.type <> 'text'
        ) THEN 1
        WHEN json_array_length(s.receipt_json, '$.snapshot.participantProjectIds') = 0 THEN 1
        ELSE NOT EXISTS (
          SELECT 1 FROM json_each(s.receipt_json, '$.snapshot.participantProjectIds') q
          WHERE NOT EXISTS (
            SELECT 1 FROM projects p
            WHERE p.tenant_id = s.tenant_id AND p.id = q.value
              AND p.deleted_at IS NULL
              AND (${grants.expenseAll} = 1 OR
                   p.id IN (SELECT value FROM json_each(${grants.expenseProjectsJson})))
          )
        )
      END = 1`
    : Prisma.empty;
  const keyset = scope.after
    ? Prisma.sql`AND (${sortColumn} < ${new Date(scope.after.sortAtMs)}
        OR (${sortColumn} = ${new Date(scope.after.sortAtMs)} AND s.id < ${scope.after.id}))`
    : Prisma.empty;

  const rows = await db.$queryRaw<RawRow[]>`
    SELECT s.id AS id, s.state AS state, s.revision AS revision,
           s.card_id AS card_id, s.owner_project_id AS owner_project_id,
           CAST(s.created_at AS INTEGER) AS created_ms,
           CAST(s.expires_at AS INTEGER) AS expires_ms,
           CAST(s.closed_at AS INTEGER) AS closed_ms,
           (s.financial_request_id IS NOT NULL AND s.confirmed_revision IS NOT NULL
             AND s.proposal_hash IS NOT NULL) AS has_confirmation,
           CASE WHEN s.state = 'APPLIED' THEN s.receipt_json END AS receipt_json
    FROM import_sessions s
    WHERE s.tenant_id = ${scope.tenantId}
      AND s.owner_user_id = ${scope.userId}
      AND ${stateFilter}
      AND EXISTS (
        SELECT 1 FROM projects p
        WHERE p.tenant_id = s.tenant_id AND p.id = s.owner_project_id
          AND p.type = ${ProjectType.PESSOAL} AND p.deleted_at IS NULL)
      AND EXISTS (
        SELECT 1 FROM credit_cards c
        WHERE c.tenant_id = s.tenant_id AND c.project_id = s.owner_project_id
          AND c.id = s.card_id AND c.deleted_at IS NULL)
      AND (${grants.cardAll} = 1 OR
           s.owner_project_id IN (SELECT value FROM json_each(${grants.cardProjectsJson})))
      ${receiptFilter}
      ${keyset}
    ORDER BY ${sortColumn} DESC, s.id DESC
    LIMIT ${IMPORT_LIST_PAGE_SIZE + 1}`;

  return rows.map((row) => {
    const createdMs = num(row.created_ms);
    const sortAtMs = applied ? num(row.closed_ms ?? 0) : createdMs;
    return {
      columns: {
        id: row.id,
        state: row.state,
        revision: num(row.revision),
        cardId: row.card_id,
        ownerProjectId: row.owner_project_id,
        createdAt: new Date(createdMs),
        expiresAt: new Date(num(row.expires_ms)),
        hasConfirmation: num(row.has_confirmation) === 1,
        receiptJson: row.receipt_json,
      },
      position: { sortAtMs, id: row.id },
    };
  });
}
