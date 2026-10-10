import { formatCurrency } from "@/lib/utils";
import type { CardImportLineOutcome } from "@reformaflow/domain";
import { OUTCOME_LABELS, type ImportAttempt } from "../_lib/import-review";

export interface PendingLine {
  externalId: string;
  title: string;
  amountCents: number;
  outcome: CardImportLineOutcome;
}

function LineItem({
  title,
  amountCents,
  label,
}: {
  title: string;
  amountCents: number;
  label: string;
}) {
  return (
    <li className="flex items-start justify-between gap-3 px-3 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm text-gray-700">{title}</span>
        <span className="block text-xs text-gray-500">{label}</span>
      </span>
      <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-gray-600">
        {formatCurrency(amountCents / 100)}
      </span>
    </li>
  );
}

/** Uma entrada por tentativa; os contadores de tentativas diferentes nunca são somados. */
export function AttemptsHistory({ attempts }: { attempts: ImportAttempt[] }) {
  if (attempts.length === 0) return null;
  return (
    <section
      aria-label="Tentativas desta importação"
      className="mb-3 space-y-3 rounded-xl border border-gray-200 bg-white p-3 text-left text-sm"
    >
      {attempts.map((a) => (
        <div key={`${a.number}-${a.importId}`}>
          <p className="font-medium text-darc-velvet">
            Tentativa {a.number} · {a.inserted} nova(s) · {a.settled}{" "}
            reaproveitada(s) sem pagamento · {a.duplicated} já existia(m)
            {a.linked > 0 ? ` · ${a.linked} vinculada(s)` : ""}
          </p>
          {a.lines.length > 0 && (
            <ul className="mt-1 divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-100">
              {a.lines.map((l) => (
                <LineItem
                  key={l.externalId}
                  title={l.title}
                  amountCents={l.amountCents}
                  label={`${OUTCOME_LABELS[l.outcome]}${l.linked ? " · vinculada" : ""}`}
                />
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

export function PendingSummary({
  pending,
  blocked,
}: {
  pending: PendingLine[];
  blocked: PendingLine[];
}) {
  if (pending.length === 0 && blocked.length === 0) return null;
  return (
    <section className="mb-3 rounded-xl border border-orange-200 bg-orange-50 p-3 text-left text-sm">
      {pending.length > 0 && (
        <>
          <p role="status" className="font-medium text-orange-900">
            {pending.length} {pending.length === 1 ? "pendência" : "pendências"}{" "}
            para decidir ou tentar de novo
          </p>
          <ul className="mt-1 divide-y divide-orange-100">
            {pending.map((p) => (
              <LineItem
                key={p.externalId}
                title={p.title}
                amountCents={p.amountCents}
                label={OUTCOME_LABELS[p.outcome]}
              />
            ))}
          </ul>
        </>
      )}
      {blocked.length > 0 && (
        <>
          <p className="mt-2 font-medium text-orange-900">
            {blocked.length} bloqueada(s), sem como importar aqui
          </p>
          <ul className="mt-1 divide-y divide-orange-100">
            {blocked.map((p) => (
              <LineItem
                key={p.externalId}
                title={p.title}
                amountCents={p.amountCents}
                label={OUTCOME_LABELS.BLOCKED}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
