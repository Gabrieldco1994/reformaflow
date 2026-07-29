'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { LoadingBlock } from '@/app/_components/LoadingBlock';
import { originLast4FromKey, sumSaidasSemConta } from '../_lib';
import { FaturasAnuaisChart } from './FaturasAnuaisChart';
import { MovimentacoesSection } from './MovimentacoesSection';
import { ResumoCards, type ResumoQuickFilterKey } from './ResumoCards';
import type { AccountViewYearlyResponse, CardInvoicesYearlyResponse } from '../_types';

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

  const { data: yearlyData, isLoading: yearlyLoading } = useQuery<CardInvoicesYearlyResponse>({
    queryKey: ['card-invoices-yearly', projectId, year],
    queryFn: () =>
      api.get(`/projects/${projectId}/monthly-overview/card-invoices-yearly?year=${year}`),
    enabled: !!projectId,
  });

  // Movimentações do ano inteiro: mesma agregação canônica (getAccountView),
  // consolidada nos 12 meses no backend — nunca uma 2ª agregação.
  const { data: accountData, isLoading: accountLoading } = useQuery<AccountViewYearlyResponse>({
    queryKey: ['account-view-yearly', projectId, year],
    queryFn: () =>
      api.get(`/projects/${projectId}/monthly-overview/account-view-yearly?year=${year}`),
    enabled: !!projectId,
  });

  // Fonte única do filtro de origem: o `last4` da lista. A chave do gráfico
  // (`card:1234`) é derivada dele, então chip e lista nunca divergem.
  const selectedOriginKey = useMemo(
    () => yearlyData?.origins.find((origin) => origin.last4 === originFilter)?.key ?? null,
    [yearlyData, originFilter],
  );

  return (
    <>
      {yearlyLoading && <div className="h-[380px] animate-pulse rounded-2xl bg-lifeone-surface" />}
      {yearlyData && !yearlyLoading && (
        <FaturasAnuaisChart
          data={yearlyData}
          selectedKey={selectedOriginKey}
          onSelectKey={(key) => {
            onOriginFilterChange(originLast4FromKey(key));
            setMonthFilter(null);
          }}
          selectedMonth={monthFilter}
          onSelectMonth={setMonthFilter}
        />
      )}

      {accountLoading && <LoadingBlock />}

      {accountData && !accountLoading && (
        <>
          <ResumoCards
            period="ano"
            caixaHoje={accountData.caixaHoje}
            carteiraHoje={accountData.carteiraHoje}
            entrouMes={accountData.entrouMes}
            saiuMes={accountData.saiuMes}
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
