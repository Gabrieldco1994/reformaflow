import { buildInstallments, type InstallmentInput } from "@reformaflow/domain";
import { formatCurrency, formatDateBR } from "@/lib/utils";

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
                · {formatDateBR(occurrence.data)}
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
