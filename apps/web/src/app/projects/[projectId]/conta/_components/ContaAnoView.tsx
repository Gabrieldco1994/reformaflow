'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { LoadingBlock } from '@/app/_components/LoadingBlock';
import { computeMovementTotals, originLast4FromKey, sumSaidasSemConta } from '../_lib';
import { MovimentacoesSection } from './MovimentacoesSection';
import { ResumoCards, type ResumoQuickFilterKey } from './ResumoCards';
import type { AccountViewYearlyResponse } from '../_types';

/**
 * Visão Conta do ANO inteiro.
 *
 * Regras que esta tela obedece (ver docs/visao-conta-faturas.md):
 *  - FLUXOS (entrou/saiu/falta pagar/previsto) e LISTAS (saídas, entradas,
 *    compras de cartão) vêm de `account-view-yearly`, que é a soma/concatenação
 *    dos 12 `getAccountView(mes)` — "ano == soma dos 12 meses", por construção.
 *  - Saldos PONTUAIS (caixa/carteira de hoje) continuam rotulados "hoje": não são
 *    somados nem lidos como fluxo do ano (`period="ano"` no ResumoCards).
 *  - Cartões NÃO aparecem como tiles aqui: `faturaAtual` anual é a soma das 12
 *    faturas e `vencimento` é o de janeiro — pagar a partir desse número pagaria a
 *    fatura errada. Quem quiser pagar clica na linha da fatura do mês, que leva
 *    para a visão daquele mês (onInvoiceAction) — lá o número é o da fatura real.
 *  - Filtrar por origem/mês é o mesmo drill que a lista faz: o chip/barra do
 *    gráfico alimenta o filtro da lista (era o que DespesasRelacionadas fazia
 *    buscando outra rota).
 */
export function ContaAnoView({
  projectId,
  year,
  originFilter,
  onOriginFilterChange,
  quickFilter,
  onQuickFilterChange,
  onInvoiceAction,
}: {
  projectId: string;
  year: string;
  originFilter: string | null;
  onOriginFilterChange: (last4: string | null) => void;
  quickFilter: ResumoQuickFilterKey | null;
  onQuickFilterChange: (key: ResumoQuickFilterKey | null) => void;
  /** Fatura clicada no ano → abre o mês dela (dueMonth) com o diálogo certo. */
  onInvoiceAction: (
    action: 'pay' | 'adjust' | 'residual' | 'undo',
    cardLast4: string,
    dueMonth: string | null,
  ) => void;
}) {
  const [monthFilter, setMonthFilter] = useState<string | null>(null);

  const { data: accountData, isLoading: accountLoading } = useQuery<AccountViewYearlyResponse>({
    queryKey: ['account-view-yearly', projectId, year],
    queryFn: () =>
      api.get(`/projects/${projectId}/monthly-overview/account-view-yearly?year=${year}`),
    enabled: !!projectId,
  });
  const totalSaidas = useMemo(
    () =>
      computeMovementTotals([
        ...(accountData?.saidas ?? []),
        ...(accountData?.comprasCartao ?? []),
      ]).totalSaidas,
    [accountData?.comprasCartao, accountData?.saidas],
  );

  return (
    <>
      {accountLoading && <LoadingBlock />}

      {accountData && !accountLoading && (
        <>
          <ResumoCards
            period="ano"
            caixaHoje={accountData.caixaHoje}
            carteiraHoje={accountData.carteiraHoje}
            entrouMes={accountData.entrouMes}
            saiuMes={totalSaidas}
            faltaPagarMes={accountData.faltaPagarMes}
            recebimentosPrevistosMes={accountData.recebimentosPrevistosMes}
            sobraPrevista={accountData.sobraPrevista}
            saiuSemConta={sumSaidasSemConta(accountData.saidas)}
            activeQuickFilter={quickFilter}
            onQuickFilterSelect={(key) => {
              onOriginFilterChange(null);
              onQuickFilterChange(key);
            }}
          />
          <MovimentacoesSection
            mode="ano"
            data={accountData}
            projectId={projectId}
            originFilter={originFilter}
            onClearOrigin={() => onOriginFilterChange(null)}
            monthFilter={monthFilter}
            onMonthFilterChange={setMonthFilter}
            onPayInvoice={(last4, dueMonth) => onInvoiceAction('pay', last4, dueMonth ?? null)}
            onAdjustInvoice={(last4, dueMonth) => onInvoiceAction('adjust', last4, dueMonth ?? null)}
            onSettleWithResidual={(last4, dueMonth) =>
              onInvoiceAction('residual', last4, dueMonth ?? null)
            }
            onUndoPayment={(last4, dueMonth) => onInvoiceAction('undo', last4, dueMonth ?? null)}
            summaryQuickFilter={quickFilter}
            onClearSummaryQuickFilter={() => onQuickFilterChange(null)}
          />
        </>
      )}
    </>
  );
}
