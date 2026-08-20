'use client';

import { formatCurrency } from '@/lib/utils';
import { REDACTED_PROJECT_LABEL } from './redacted-project';

interface Props {
  allocations: any[];
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
        #490 / D-D — a 375px este scroller mede clientWidth 269 vs scrollWidth
        ~371: a coluna "Valor" nasce cortada e só fica legível depois de
        arrastar ~65px na horizontal. O `min-content` da tabela inteira com
        dados reais é ~349px, então NENHUM ajuste de largura (padding menor,
        fonte menor, data curta) fecha a conta — a saída é a tabela virar lista
        empilhada no mobile, o que é decisão de produto e está reportada, não
        resolvida aqui. O que entra agora é a regra da casa que estava sendo
        violada: valor monetário não quebra linha.
      */}
      <div className="overflow-x-auto" data-allocation-history-scroller>
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

      <div className="mt-4 pt-4 border-t border-darc-linen flex justify-between items-center">
        <span className="text-sm font-medium text-darc-velvet">Total Alocado:</span>
        <span className="text-lg font-bold text-darc-velvet tabular-nums">
          {formatCurrency(allocations.reduce((sum, a) => sum + a.valor, 0) / 100)}
        </span>
      </div>
    </div>
  );
}
