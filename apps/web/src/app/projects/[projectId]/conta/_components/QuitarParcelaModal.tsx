'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { isNeutralExpenseType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getExpenseOptions } from '../../expenses/_types';
import { centsToReaisInput, currencyInputToCents, maskCurrencyInput } from '@/lib/currency-input';
import {
  buildEspelhoQuitacaoPayload,
  type QuitacaoMeio,
} from '../../expenses/_lib/quitarParcelaCross';

interface TenantCard {
  id: string;
  nickname?: string | null;
  brand: string;
  last4: string;
}

interface TenantAccount {
  id: string;
  nickname?: string | null;
  institution: string;
  last4?: string | null;
}

interface Props {
  projectId: string;
  foreignExpenseId: string;
  parcelaIndex: number;
  /** Valor sugerido da parcela (centavos). */
  valorSugerido: number;
  descricao: string;
  /** Data sugerida (ISO YYYY-MM-DD). */
  dataSugerida: string;
  onClose: () => void;
  onDone: () => void;
}

/** Prefixo estável para value do <select> de meio, para discriminar bank/card. */
const BANK_PREFIX = 'bank:';
const CARD_PREFIX = 'card:';

/**
 * Modal de quitação de uma parcela cross-project pela conta pessoal.
 *
 * Fluxo (2 etapas, ver `quitarParcelaCross`):
 *   1. cria um ESPELHO pago no PESSOAL (POST /expenses);
 *   2. concilia o espelho com a parcela-alvo (POST /expenses/:id/conciliar-parcela).
 *
 * Nunca marca a parcela como paga sem gerar o movimento — evita o "sumiço" na
 * Visão Conta.
 */
export function QuitarParcelaModal({
  projectId,
  foreignExpenseId,
  parcelaIndex,
  valorSugerido,
  descricao,
  dataSugerida,
  onClose,
  onDone,
}: Props) {
  const queryClient = useQueryClient();
  // Um espelho de quitação é um PAGAMENTO REAL: precisa contar no caixa. Tipos
  // neutros (movimentação interna etc.) são suprimidos do caixa PESSOAL, então
  // ficam fora das opções para não gerar "money-vanish".
  const tipoOptions = useMemo(
    () => getExpenseOptions('PESSOAL').filter((o) => !isNeutralExpenseType(o.value)),
    [],
  );

  const { data: cards = [] } = useQuery<TenantCard[]>({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 60_000,
  });
  const { data: accounts = [] } = useQuery<TenantAccount[]>({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    staleTime: 60_000,
  });

  const [meioValue, setMeioValue] = useState('');
  const [valorReais, setValorReais] = useState(centsToReaisInput(valorSugerido));
  const [dataPagamento, setDataPagamento] = useState(dataSugerida);
  const [tipoDespesa, setTipoDespesa] = useState<string>(tipoOptions[0]?.value ?? '');
  const [erro, setErro] = useState<string | null>(null);

  const meioOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const a of accounts) {
      const tail = a.last4 ? ` ••${a.last4}` : '';
      opts.push({
        value: `${BANK_PREFIX}${a.id}`,
        label: `Conta · ${a.nickname || a.institution}${tail}`,
      });
    }
    for (const c of cards) {
      opts.push({
        value: `${CARD_PREFIX}${c.id}`,
        label: `Cartão · ${c.nickname || c.brand} ••${c.last4}`,
      });
    }
    return opts;
  }, [accounts, cards]);

  const parseMeio = (): QuitacaoMeio | null => {
    if (meioValue.startsWith(BANK_PREFIX)) {
      return { kind: 'bank', bankAccountId: meioValue.slice(BANK_PREFIX.length) };
    }
    if (meioValue.startsWith(CARD_PREFIX)) {
      return { kind: 'card', cardId: meioValue.slice(CARD_PREFIX.length) };
    }
    return null;
  };

  const quitar = useMutation({
    mutationFn: async () => {
      const meio = parseMeio();
      if (!meio) throw new Error('Escolha a conta ou cartão de pagamento.');
      const valorCentavos = currencyInputToCents(valorReais);
      if (valorCentavos <= 0) throw new Error('Informe um valor válido.');
      if (!tipoDespesa) throw new Error('Escolha a categoria da despesa.');
      if (!dataPagamento) throw new Error('Informe a data de pagamento.');

      const payload = buildEspelhoQuitacaoPayload({
        descricao,
        valorCentavos,
        dataPagamento,
        tipoDespesa,
        meio,
      });
      const created = await api.post<{ id: string }>(
        `/projects/${projectId}/expenses`,
        payload,
      );
      // O espelho já existe e conta como gasto real no caixa. Se a conciliação
      // falhar (alvo neutro/rateado, rede, 4xx/5xx), removemos o espelho para
      // não deixar um débito "fantasma" na Visão Conta (create+settle não são
      // atômicos entre requests).
      try {
        await api.post(`/projects/${projectId}/expenses/${created.id}/conciliar-parcela`, {
          targetExpenseId: foreignExpenseId,
          parcelaIndex,
          realValor: valorCentavos,
        });
      } catch (err) {
        try {
          await api.delete(`/projects/${projectId}/expenses/${created.id}`);
        } catch {
          /* best-effort: se a limpeza falhar, o erro original ainda é propagado */
        }
        throw err;
      }
    },
    onSuccess: () => {
      // Invalida todos os caches de caixa afetados (Visão Conta + overview).
      for (const key of [
        'account-view',
        'monthly-overview',
        'expenses',
        'cash-flow',
        'dashboard',
        'cross-project-expenses',
      ]) {
        queryClient.invalidateQueries({ queryKey: [key, projectId] });
      }
      queryClient.invalidateQueries({ queryKey: ['pendencias-financeiras', projectId] });
      queryClient.invalidateQueries({ queryKey: ['pendencias', projectId] });
      toast.success('Parcela quitada e conciliada');
      onDone();
    },
    onError: (e: Error) => {
      setErro(e.message);
      toast.error(`Erro ao quitar parcela: ${e.message}`);
    },
  });

  return (
    <Modal open onClose={onClose} title="Quitar parcela" size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setErro(null);
          quitar.mutate();
        }}
        className="space-y-3 py-1"
      >
        <div className="rounded-lg bg-lifeone-surface px-3 py-2 text-sm text-lifeone-ink-2">
          <span className="font-semibold text-lifeone-ink">{descricao}</span>
          <span className="ml-1 text-lifeone-ink-3">· parcela {parcelaIndex + 1}</span>
        </div>

        <Select
          label="Pagar com"
          options={meioOptions}
          value={meioValue}
          onChange={(e) => setMeioValue(e.target.value)}
        />

        <Select
          label="Categoria"
          options={tipoOptions}
          value={tipoDespesa}
          onChange={(e) => setTipoDespesa(e.target.value)}
        />

        <Input
          label="Valor (R$)"
          type="text"
          inputMode="numeric"
          value={valorReais}
          onChange={(e) => setValorReais(maskCurrencyInput(e.target.value))}
        />

        <Input
          label="Data de pagamento"
          type="date"
          value={dataPagamento}
          onChange={(e) => setDataPagamento(e.target.value)}
        />

        {erro && (
          <p className="rounded-lg bg-[#FCEBE9] px-3 py-2 text-xs font-medium text-[#D92D20]">
            {erro}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-semibold text-lifeone-ink-3 hover:bg-lifeone-surface"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={quitar.isPending}
            className="rounded-lg bg-lifeone-blue px-4 py-2 text-sm font-semibold text-white transition hover:brightness-95 disabled:opacity-60"
          >
            {quitar.isPending ? 'Quitando…' : 'Confirmar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
