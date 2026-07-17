'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isSinglePaymentForm, hasFeature, ProjectType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CATEGORIA_MAO_DE_OBRA_OPTIONS, FORMA_PAGAMENTO_OPTIONS } from '@/lib/expense-options';
import { getExpenseOptions } from '../_types';
import { maskReaisInput, reaisToCents } from '../_lib/money';
import type { NewTargetDraft } from '../_types';
import type { WizardDraft } from '../_hooks/useNovaDespesaWizard';

interface ProjectLite {
  id: string;
  name: string;
  type: string;
  rooms?: { id: string; name: string }[];
}

interface Props {
  /** Projeto DONO da compra-fonte (excluído da lista de destinos). */
  currentProjectId: string;
  /** Rascunho da fonte, usado para pré-preencher o alvo novo. */
  source: WizardDraft;
  /** Emite o alvo pronto (NÃO faz POST — a criação ocorre no ratear-mixed). */
  onAdd: (draft: NewTargetDraft) => void;
  onCancel: () => void;
}

/**
 * Corpo de campos para CRIAR um alvo novo (cross-project) dentro do cesto de
 * vínculos. Extraído/duplicado do `CreateLinkedExpenseModal` — porém NÃO faz
 * POST: apenas monta um `NewTargetDraft` e devolve via `onAdd` (a persistência
 * é atômica no endpoint `ratear-mixed`). Mantivemos o `CreateLinkedExpenseModal`
 * intacto (ainda usado por `VinculosFields`, com seu POST+link próprio).
 */
export function LinkedExpenseFields({ currentProjectId, source, onAdd, onCancel }: Props) {
  const { data: projects = [] } = useQuery<ProjectLite[]>({
    queryKey: ['tenant', 'projects'],
    queryFn: () => api.get('/projects'),
    staleTime: 60_000,
  });

  // Só projetos com o módulo de despesas podem ser alvo (a API rejeita os demais).
  const otherProjects = useMemo(
    () =>
      projects.filter(
        (p) => p.id !== currentProjectId && hasFeature(p.type as ProjectType, 'expenses'),
      ),
    [projects, currentProjectId],
  );

  const [targetProjectId, setTargetProjectId] = useState('');
  const [titulo, setTitulo] = useState(source.titulo ?? '');
  const [fornecedor, setFornecedor] = useState(source.fornecedor ?? '');
  const [tipoDespesa, setTipoDespesa] = useState('');
  const [categoriaMaoDeObra, setCategoriaMaoDeObra] = useState(source.categoriaMaoDeObra ?? '');
  const [roomId, setRoomId] = useState('');
  const [valor, setValor] = useState(source.valor ?? '');
  const [quantidade, setQuantidade] = useState(source.quantidade ?? '1');
  const [formaPagamento, setFormaPagamento] = useState(source.formaPagamento || 'A_VISTA');
  const [dataPagamento, setDataPagamento] = useState('');
  const [quantidadeParcela, setQuantidadeParcela] = useState('');
  const [dataInicioParcela, setDataInicioParcela] = useState('');
  const [status, setStatus] = useState<'PLANEJADO' | 'PAGO'>('PLANEJADO');
  const [error, setError] = useState<string | null>(null);

  const targetProject = useMemo(
    () => otherProjects.find((p) => p.id === targetProjectId) ?? null,
    [otherProjects, targetProjectId],
  );

  const tipoOptions = useMemo(() => {
    if (!targetProject) return [];
    return getExpenseOptions(targetProject.type);
  }, [targetProject]);

  const showRooms = targetProject?.type === 'REFORMA';
  const showMaoDeObra = targetProject?.type === 'REFORMA' && tipoDespesa === 'MAO_DE_OBRA';

  const roomOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: '', label: '— Sem ambiente —' }];
    for (const r of targetProject?.rooms ?? []) opts.push({ value: r.id, label: r.name });
    return opts;
  }, [targetProject]);

  // Ao trocar o destino: se o tipo atual (herdado da fonte) não valer lá, ajusta.
  useEffect(() => {
    if (!targetProject) return;
    const sourceType = source.tipoDespesa;
    if (sourceType && tipoOptions.some((o) => o.value === sourceType)) {
      setTipoDespesa(sourceType);
    } else if (tipoDespesa && !tipoOptions.some((o) => o.value === tipoDespesa)) {
      setTipoDespesa(tipoOptions[0]?.value ?? '');
    } else if (!tipoDespesa && tipoOptions.length > 0) {
      setTipoDespesa(tipoOptions[0].value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetProject?.id]);

  function handleAdd() {
    if (!targetProjectId) {
      setError('Escolha o projeto destino');
      return;
    }
    if (!tipoDespesa) {
      setError('Escolha o tipo da despesa');
      return;
    }
    const valorNum = reaisToCents(String(valor)) / 100;
    if (!valorNum || valorNum <= 0) {
      setError('Valor inválido');
      return;
    }
    setError(null);
    onAdd({
      targetProjectId,
      tipoDespesa,
      titulo: titulo || undefined,
      fornecedor: fornecedor || undefined,
      categoriaMaoDeObra: showMaoDeObra && categoriaMaoDeObra ? categoriaMaoDeObra : undefined,
      roomId: showRooms && roomId ? roomId : undefined,
      valor: String(valor),
      quantidade: String(quantidade) || '1',
      formaPagamento,
      status,
      dataPagamento: isSinglePaymentForm(formaPagamento) && dataPagamento ? dataPagamento : undefined,
      quantidadeParcela:
        formaPagamento === 'PARCELADO' || formaPagamento === 'QUINZENAL'
          ? quantidadeParcela || undefined
          : undefined,
      dataInicioParcela:
        formaPagamento === 'PARCELADO' || formaPagamento === 'QUINZENAL'
          ? dataInicioParcela || undefined
          : undefined,
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/40 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">
        Criar despesa nova em outro projeto
      </p>

      <Select
        label="Projeto destino"
        name="targetProjectId"
        value={targetProjectId}
        onChange={(e) => setTargetProjectId(e.target.value)}
        options={otherProjects.map((p) => ({ value: p.id, label: `${p.name} · ${p.type}` }))}
      />

      {otherProjects.length === 0 && (
        <p className="text-xs text-amber-600">Nenhum projeto disponível para vínculo cross-project.</p>
      )}

      {targetProject && (
        <>
          <Select
            label="Tipo da despesa"
            name="tipoDespesa"
            value={tipoDespesa}
            onChange={(e) => setTipoDespesa(e.target.value)}
            options={tipoOptions}
          />

          {showMaoDeObra && (
            <Select
              label="Categoria Mão de Obra"
              name="categoriaMaoDeObra"
              value={categoriaMaoDeObra}
              onChange={(e) => setCategoriaMaoDeObra(e.target.value)}
              options={CATEGORIA_MAO_DE_OBRA_OPTIONS}
            />
          )}

          {showRooms && (
            <Select
              label="Ambiente"
              name="roomId"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              options={roomOptions}
            />
          )}

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Valor (R$)"
              name="valor"
              type="text"
              inputMode="numeric"
              value={valor}
              onChange={(e) => setValor(maskReaisInput(e.target.value))}
            />
            <Input
              label="Quantidade"
              name="quantidade"
              type="number"
              min="1"
              value={quantidade}
              onChange={(e) => setQuantidade(e.target.value)}
            />
          </div>

          <Input label="Título" name="titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
          <Input
            label="Fornecedor"
            name="fornecedor"
            value={fornecedor}
            onChange={(e) => setFornecedor(e.target.value)}
          />

          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Forma de pagamento"
              name="formaPagamento"
              value={formaPagamento}
              onChange={(e) => setFormaPagamento(e.target.value)}
              options={FORMA_PAGAMENTO_OPTIONS}
            />
            <Select
              label="Status"
              name="status"
              value={status}
              onChange={(e) => setStatus(e.target.value as 'PLANEJADO' | 'PAGO')}
              options={[
                { value: 'PLANEJADO', label: 'Planejado' },
                { value: 'PAGO', label: 'Pago' },
              ]}
            />
          </div>

          {isSinglePaymentForm(formaPagamento) && (
            <Input
              label="Data do pagamento"
              name="dataPagamento"
              type="date"
              value={dataPagamento}
              onChange={(e) => setDataPagamento(e.target.value)}
            />
          )}

          {(formaPagamento === 'PARCELADO' || formaPagamento === 'QUINZENAL') && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Qtd parcelas"
                name="quantidadeParcela"
                type="number"
                min="1"
                value={quantidadeParcela}
                onChange={(e) => setQuantidadeParcela(e.target.value)}
              />
              <Input
                label="Data início parcela"
                name="dataInicioParcela"
                type="date"
                value={dataInicioParcela}
                onChange={(e) => setDataInicioParcela(e.target.value)}
              />
            </div>
          )}
        </>
      )}

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="button" disabled={!targetProjectId} onClick={handleAdd}>
          Adicionar ao cesto
        </Button>
      </div>
    </div>
  );
}
