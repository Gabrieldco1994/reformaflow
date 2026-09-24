"use client";

import { MovimentacaoRow } from "../../conta/_components/MovimentacaoRow";
import type { YearCarryEntry } from "./derive";
import { Card } from "./ui";

const noAction = () => undefined;

export default function YearCarryIncomeRow({
  entry,
}: {
  entry: YearCarryEntry;
}) {
  return (
    <Card title="Receita projetada de janeiro">
      {/* ponytail: fieldset desabilita também o botão de título herdado da linha. */}
      <fieldset
        disabled
        aria-label="Entrada automática projetada"
        className="min-w-0"
      >
        <MovimentacaoRow
          item={entry}
          originLabel={() => null}
          onEditExpense={noAction}
          onEditReceita={noAction}
          onToggleExpense={noAction}
          onToggleReceita={noAction}
          onPayInvoice={noAction}
          onAdjustInvoice={noAction}
          onSettleWithResidual={noAction}
          onQuitar={noAction}
          onRemoveExpense={noAction}
          onRemoveReceita={noAction}
        />
      </fieldset>
      <p className="mt-2 text-xs text-[var(--ck-muted)]">
        Entrada automática incluída na receita e no resultado projetados. Não é
        dinheiro recebido e não movimenta conta bancária nem Carteira.
      </p>
    </Card>
  );
}
