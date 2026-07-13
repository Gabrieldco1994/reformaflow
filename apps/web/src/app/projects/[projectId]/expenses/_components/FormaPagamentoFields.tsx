'use client';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { moneyDetail } from '@/lib/money';
import { FORMA_PAGAMENTO_OPTIONS } from '@/lib/expense-options';
import { isSinglePaymentForm } from '@reformaflow/domain';
import type { Expense } from '@/types';

export interface FormaPagamentoFieldsProps {
  formaPagamento: string;
  setFormaPagamento: (value: string) => void;
  dataPagamento: string;
  setDataPagamento: (value: string) => void;
  dataInicioParcela: string;
  setDataInicioParcela: (value: string) => void;
  /** Habilita "Despesa fixa (recorrente)" — apenas PESSOAL. */
  allowRecorrente?: boolean;
  editing: Expense | null;
  /** Estado local mantido no ExpenseFormModal (não mover para fora). */
  recorrente: boolean;
  setRecorrente: (value: boolean) => void;
  /**
   * Campos opcionalmente controlados (wizard). Quando fornecidos, renderizam
   * controlados; quando ausentes, mantêm `defaultValue`/FormData como o
   * ExpenseFormModal atual. Aditivos e retrocompatíveis.
   */
  quantidadeParcelaValue?: string;
  onQuantidadeParcelaChange?: (value: string) => void;
  recorrenciaFimValue?: string;
  onRecorrenciaFimChange?: (value: string) => void;
  dataCompraValue?: string;
  onDataCompraChange?: (value: string) => void;
  valorTotalCents?: number;
}

/**
 * Bloco PAGAMENTO do formulário de despesa — extraído do ExpenseFormModal.
 * Renderiza forma de pagamento, data do pagamento, despesa fixa (recorrente),
 * parcelas e data da compra. Nomes de inputs preservados (lidos via FormData).
 */
export function FormaPagamentoFields({
  formaPagamento,
  setFormaPagamento,
  dataPagamento,
  setDataPagamento,
  dataInicioParcela,
  setDataInicioParcela,
  allowRecorrente,
  editing,
  recorrente,
  setRecorrente,
  quantidadeParcelaValue,
  onQuantidadeParcelaChange,
  recorrenciaFimValue,
  onRecorrenciaFimChange,
  dataCompraValue,
  onDataCompraChange,
  valorTotalCents,
}: FormaPagamentoFieldsProps) {
  const parcelaControlled =
    quantidadeParcelaValue !== undefined && onQuantidadeParcelaChange !== undefined;
  const recFimControlled =
    recorrenciaFimValue !== undefined && onRecorrenciaFimChange !== undefined;
  const dataCompraControlled =
    dataCompraValue !== undefined && onDataCompraChange !== undefined;
  const parcelas = Number.parseInt(quantidadeParcelaValue ?? '', 10);
  const parcelaCents =
    Number.isFinite(parcelas) && parcelas > 0 && (valorTotalCents ?? 0) > 0
      ? Math.round((valorTotalCents ?? 0) / parcelas)
      : null;
  return (
    <>
      <Select
        label="Forma de Pagamento"
        name="formaPagamento"
        options={FORMA_PAGAMENTO_OPTIONS}
        required
        value={formaPagamento}
        onChange={(e) => setFormaPagamento(e.target.value)}
      />

      {isSinglePaymentForm(formaPagamento) && (
        <div>
          <Input
            label="Data do Pagamento"
            name="dataPagamento"
            type="date"
            value={dataPagamento}
            onChange={(e) => setDataPagamento(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-darc-velvet/50">
            Quando o dinheiro sai da conta (caixa). É esta data que faz a despesa cair no mês.
          </p>
        </div>
      )}

      {/* Despesa fixa (recorrente mensal) — apenas PESSOAL, pagamento único */}
      {allowRecorrente && isSinglePaymentForm(formaPagamento) && (
        <div className="rounded-xl border border-darc-linen p-3">
          <label className="flex items-center gap-2.5 text-sm font-medium text-darc-velvet cursor-pointer">
            <input
              type="checkbox"
              name="recorrente"
              checked={recorrente}
              onChange={(e) => setRecorrente(e.target.checked)}
              className="h-4 w-4 rounded border-darc-mist text-orange-500 focus:ring-orange-400"
            />
            Despesa fixa (repete todo mês)
          </label>
          {recorrente && (
            <div className="mt-3">
              {recFimControlled ? (
                <Input
                  label="Repetir até (opcional)"
                  name="recorrenciaFim"
                  type="month"
                  value={recorrenciaFimValue}
                  onChange={(e) => onRecorrenciaFimChange?.(e.target.value)}
                />
              ) : (
                <Input
                  key={editing?.id ?? 'new'}
                  label="Repetir até (opcional)"
                  name="recorrenciaFim"
                  type="month"
                  defaultValue={editing?.recorrenciaFim ? editing.recorrenciaFim.slice(0, 7) : ''}
                />
              )}
              <p className="mt-1 text-[11px] text-darc-velvet/50">
                Deixe em branco para repetir sem data final. Aparece automaticamente em cada mês (sem criar lançamentos).
              </p>
            </div>
          )}
        </div>
      )}

      {(formaPagamento === 'PARCELADO' || formaPagamento === 'QUINZENAL') && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-4">
          {parcelaControlled ? (
            <Input
              label="Qtd Parcelas"
              name="quantidadeParcela"
              type="number"
              min="1"
              value={quantidadeParcelaValue}
              onChange={(e) => onQuantidadeParcelaChange?.(e.target.value)}
            />
          ) : (
            <Input
              label="Qtd Parcelas"
              name="quantidadeParcela"
              type="number"
              min="1"
              defaultValue={editing?.quantidadeParcela ?? ''}
            />
          )}
          <Input
            label="Data de Início"
            name="dataInicioParcela"
            type="date"
            value={dataInicioParcela}
            onChange={(e) => setDataInicioParcela(e.target.value)}
          />
          </div>
          {parcelaCents !== null && (
          <p className="text-[11px] text-darc-velvet/60">
            Cada {formaPagamento === 'QUINZENAL' ? 'quinzena' : 'parcela'}:{" "}
            <strong className="font-semibold text-darc-velvet">
              {moneyDetail(parcelaCents)}
            </strong>
          </p>
          )}
        </div>
      )}

      <div>
        {dataCompraControlled ? (
          <Input
            label="Data da compra (opcional)"
            name="dataCompra"
            type="date"
            value={dataCompraValue}
            onChange={(e) => onDataCompraChange?.(e.target.value)}
          />
        ) : (
          <Input
            key={`dc-${editing?.id ?? 'new'}`}
            label="Data da compra (opcional)"
            name="dataCompra"
            type="date"
            defaultValue={editing?.dataCompra ? editing.dataCompra.slice(0, 10) : ''}
          />
        )}
        <p className="mt-1 text-[11px] text-darc-velvet/50">
          Quando a compra foi feita (competência). Para cartão, a fatura é calculada a partir desta data. Vazio = usa a data de pagamento.
        </p>
      </div>
    </>
  );
}
