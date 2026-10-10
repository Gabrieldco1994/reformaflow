import { buildInstallments, type InstallmentInput } from "@reformaflow/domain";
import { formatCurrency, formatDateBR } from "@/lib/utils";

/**
 * `buildInstallments` devolve o dia-calendário financeiro como Date à meia-noite
 * UTC. Formatar o Date direto usaria getDate() local (19/09 em BRT para
 * 2026-09-20). Convertemos para a string ISO canônica, que `formatDateBR`
 * preserva sem aplicar timezone (política de datas).
 */
function occurrenceDateLabel(date: Date): string {
  return Number.isNaN(date.getTime())
    ? formatDateBR(null)
    : formatDateBR(date.toISOString().slice(0, 10));
}

export function DocumentedSchedule({
  expense,
}: {
  expense: Omit<InstallmentInput, "dataPagamento" | "dataInicioParcela"> & {
    dataPagamento?: string | null;
    dataInicioParcela?: string | null;
  };
}) {
  const occurrences = buildInstallments({
    ...expense,
    dataPagamento: expense.dataPagamento
      ? new Date(expense.dataPagamento)
      : null,
    dataInicioParcela: expense.dataInicioParcela
      ? new Date(expense.dataInicioParcela)
      : null,
  });
  return (
    <section className="space-y-2 rounded-xl border border-darc-linen p-3">
      <h3 className="text-sm font-semibold text-darc-velvet">
        Cronograma documentado
      </h3>
      <p className="text-xs text-darc-velvet/70">
        Aqui você edita apenas os dados descritivos. Valores, datas e faturas
        são preservados. Alterações financeiras precisam de correção assistida.
      </p>
      <ul className="divide-y divide-darc-linen">
        {occurrences.map((occurrence) => (
          <li
            key={occurrence.index}
            className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
          >
            <div className="min-w-0">
              <p>
                {occurrence.parcela
                  ? `Parcela ${occurrence.parcela}`
                  : "Lançamento"}{" "}
                · {occurrenceDateLabel(occurrence.data)}
              </p>
              {occurrence.invoiceDueMonth && (
                <p className="text-xs text-darc-velvet/70">
                  Fatura {occurrence.invoiceDueMonth}
                </p>
              )}
            </div>
            <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums">
              {formatCurrency(occurrence.valor / 100)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
