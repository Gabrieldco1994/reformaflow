'use client';

import { formatCurrency } from '@/lib/utils';
import { REDACTED_PROJECT_LABEL } from './redacted-project';
import { AllocationHistoryRow, type AllocationHistoryItem } from './AllocationHistoryRow';

interface Props {
  allocations: AllocationHistoryItem[];
}

/**
 * Histórico congelado (#449 B2): a exclusão saiu junto com a rota `DELETE`.
 * Manter o botão só produziria um 403 — o mesmo erro de "CTA morta" que já
 * apareceu em produção neste repo.
 */
export default function AllocationHistory({ allocations }: Props) {
  if (allocations.length === 0) {
    return (
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-6 text-center">
        <p className="text-darc-velvet/60">Nenhuma alocação realizada ainda.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 lg:p-6">
      <h2 className="font-editorial italic text-lg text-darc-velvet mb-4">Histórico de Alocações</h2>
      
      {/*
        #490 / D-D — dois layouts para o mesmo dado, cortados por CSS.

        Abaixo de `sm` a tabela vira lista empilhada (`AllocationHistoryRow`):
        a 375px o scroller media clientWidth 269 vs scrollWidth 372 e a coluna
        "Valor" nascia 103px fora da tela. O corte é por media query do
        Tailwind, e não por `matchMedia` em JS, de propósito — largura só
        existe no cliente, então decidir layout em JS traria descasamento de
        hidratação. O custo é as duas variantes coexistirem no DOM; a oculta
        fica `display:none`, invisível também para leitor de tela.
      */}
      <div className="space-y-2 sm:hidden">
        {allocations.map((alloc) => (
          <AllocationHistoryRow key={alloc.id} allocation={alloc} />
        ))}
      </div>

      <div className="hidden overflow-x-auto sm:block" data-allocation-history-scroller>
        <table className="w-full">
          <thead>
            <tr className="border-b border-darc-linen">
              <th className="text-left py-2 px-2 text-sm font-medium text-darc-velvet">Data</th>
              <th className="text-left py-2 px-2 text-sm font-medium text-darc-velvet">Projeto</th>
              <th className="text-left py-2 px-2 text-sm font-medium text-darc-velvet">Mês Ref.</th>
              <th className="text-right py-2 px-2 text-sm font-medium text-darc-velvet">Valor</th>
            </tr>
          </thead>
          <tbody>
            {allocations.map((alloc) => (
              <tr key={alloc.id} className="border-b border-darc-linen/50">
                <td className="py-3 px-2 text-sm text-darc-velvet">
                  {new Date(alloc.dataAlocacao).toLocaleDateString('pt-BR')}
                </td>
                <td className="py-3 px-2 text-sm text-darc-velvet">
                  {alloc.targetProject?.name ?? REDACTED_PROJECT_LABEL}
                  {alloc.descricao && (
                    <span className="block text-xs text-darc-velvet/60">{alloc.descricao}</span>
                  )}
                </td>
                <td className="py-3 px-2 text-sm text-darc-velvet">{alloc.mes}</td>
                <td
                  data-allocation-value
                  className="py-3 px-2 text-sm text-darc-velvet text-right tabular-nums font-medium whitespace-nowrap"
                >
                  {formatCurrency(alloc.valor / 100)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        AQUI NÃO VAI TOTAL. Havia um rodapé "Total Alocado" somando
        `allocations.reduce(...)` no template — mesmo rótulo do card "Resumo do
        Budget", logo acima nesta mesma tela.

        Ele saiu por REDUNDÂNCIA COM RISCO LATENTE, não por divergência
        observada: os dois números batem hoje. Só que batem por acidente.
        O card lê `summary.totalAllocated` de `GET /budget-allocations/summary/:id`;
        a lista soma o retorno de `GET /budget-allocations?sourceProjectId=`,
        e `findAll` carrega um filtro de escopo do requisitante que
        `getSummary` NÃO tem. Os dois só coincidem porque o portão de leitura
        (ADMIN/OWNER não-convidado) faz esse escopo colapsar em `null`.
        Afrouxar a permissão faria os dois divergirem em silêncio, sob rótulo
        idêntico — e igualdade que depende de condição não declarada não é
        igualdade, é coincidência com prazo.

        Além disso: dois rótulos iguais já são defeito QUANDO OS NÚMEROS BATEM,
        porque obrigam o usuário a conferir se batem. E somar dinheiro no
        template é derivação financeira na camada de view — o total é do
        servidor, e ele já está na tela, no card, sempre visível.
      */}
    </div>
  );
}
