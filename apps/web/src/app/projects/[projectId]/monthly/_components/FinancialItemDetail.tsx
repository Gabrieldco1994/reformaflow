'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { FinancialItemCardV1 } from '@reformaflow/domain';
import { formatCurrency } from '@/lib/utils';
import { formaLabel } from '@/lib/expense-options';

/* ── Breakpoint hook (no existing useIsMobile in the project) ── */
function useIsMobile(breakpoint = 768): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = () => setMobile(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [breakpoint]);
  return mobile;
}

/* ── Status label map ── */
const STATUS_LABELS: Record<string, string> = {
  PAGO: 'Pago',
  PLANEJADO: 'Planejado',
  EM_CAIXA: 'Recebido',
  PREVISTO: 'Previsto',
  PARCIAL: 'Parcial',
};

function statusLabel(raw: string): string {
  return STATUS_LABELS[raw] ?? raw;
}

/* ── Kind label map ── */
const KIND_LABELS: Record<FinancialItemCardV1['kind'], string> = {
  expense: 'Despesa',
  receipt: 'Recebimento',
  invoice: 'Fatura',
};

/* ── Detail content (shared between sheet & drawer) ── */
function DetailContent({
  item,
  onClose,
}: {
  item: FinancialItemCardV1;
  onClose: () => void;
}) {
  const rows: Array<{ label: string; value: string | null }> = [
    { label: 'Tipo', value: KIND_LABELS[item.kind] },
    { label: 'Finalidade', value: item.purposeLabel },
    { label: 'Origem', value: item.originProjectName },
    { label: 'Data', value: new Date(item.date).toLocaleDateString('pt-BR') },
    {
      label: 'Valor',
      value: formatCurrency(item.amountCents / 100),
    },
    { label: 'Status', value: statusLabel(item.status) },
    { label: 'Título', value: item.title },
    { label: 'Fornecedor', value: item.supplier },
    { label: 'Parcela', value: item.installment },
    {
      label: 'Forma de pagamento',
      value: item.paymentForm ? formaLabel(item.paymentForm) : null,
    },
    {
      label: 'Cartão',
      value: item.relationship?.cardLast4
        ? `•••• ${item.relationship.cardLast4}`
        : null,
    },
    {
      label: 'Conta',
      value: item.relationship?.bankLast4
        ? `•••• ${item.relationship.bankLast4}`
        : null,
    },
  ];

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-lifeone-hairline px-4 py-3">
        <h2 className="text-[16px] font-semibold text-lifeone-ink">
          Detalhe do lançamento
        </h2>
        <button
          type="button"
          aria-label="Fechar"
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-lifeone-ink-3 transition-colors hover:bg-lifeone-sidebar"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex flex-col gap-3 p-4">
        {item.isEspelho && (
          <span className="self-start rounded-full bg-[#F3F3F3] px-2 py-0.5 text-[11px] font-semibold text-lifeone-ink-3">
            Espelho
          </span>
        )}
        {item.isNeutral && (
          <span className="self-start rounded-full bg-[#F3F3F3] px-2 py-0.5 text-[11px] font-semibold text-lifeone-ink-3">
            Neutro
          </span>
        )}

        {/* hasEvidence — ready for H2, never true in V1 */}
        {item.hasEvidence && (
          <span className="self-start rounded-full bg-[#EAF7EE] px-2 py-0.5 text-[11px] font-semibold text-[#1E924A]">
            Com comprovante
          </span>
        )}

        <dl className="flex flex-col gap-2">
          {rows.map(
            (r) =>
              r.value != null && (
                <div key={r.label} className="flex items-baseline justify-between gap-2">
                  <dt className="text-[13px] text-lifeone-ink-3">{r.label}</dt>
                  <dd
                    className={`text-right text-[14px] font-medium text-lifeone-ink ${
                      r.label === 'Valor' ? 'whitespace-nowrap' : ''
                    }`}
                  >
                    {r.value}
                  </dd>
                </div>
              ),
          )}
        </dl>
      </div>
    </div>
  );
}

/* ── Main component: sheet (mobile) or drawer (desktop) ── */
export interface FinancialItemDetailProps {
  item: FinancialItemCardV1;
  onClose: () => void;
}

export function FinancialItemDetail({ item, onClose }: FinancialItemDetailProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div
        data-testid="financial-detail-sheet"
        className="fixed inset-0 z-50 flex items-end"
      >
        {/* backdrop */}
        <div
          className="absolute inset-0 bg-black/40"
          onClick={onClose}
          aria-hidden="true"
        />
        <div className="relative w-full max-h-[92dvh] overflow-y-auto rounded-t-3xl bg-white pb-safe">
          <div className="flex justify-center pt-3 pb-1">
            <div className="h-1 w-10 rounded-full bg-lifeone-hairline" />
          </div>
          <DetailContent item={item} onClose={onClose} />
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="financial-detail-drawer"
      className="fixed inset-y-0 right-0 z-50 flex"
    >
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/20"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative ml-auto h-full w-full max-w-md overflow-y-auto bg-white shadow-xl">
        <DetailContent item={item} onClose={onClose} />
      </div>
    </div>
  );
}
