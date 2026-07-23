'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { hasFeature, ProjectType, type PurchasePlanHorizonte, type PurchasePlanItem } from '@reformaflow/domain';
import { Calculator, Plus, Trash2 } from 'lucide-react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { maskCurrencyInput, currencyInputToCents, centsToReaisInput } from '@/lib/currency-input';
import { moneyGlance } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card, COCKPIT_THEME } from '../monthly/_cockpit/ui';
import type { DreOverviewResponse } from '../dre/_types';
import { PlanVeredito } from './_components/PlanVeredito';

interface ScenarioItemApi {
  id: string;
  nome: string;
  tipo: 'A_VISTA' | 'PARCELADO' | 'FINANCIAMENTO';
  valorCents: number;
  entradaCents: number | null;
  parcelas: number | null;
  taxaJurosMensalBps: number | null;
  sistema: 'PRICE' | 'SAC' | null;
  mesInicio: string;
  incluido: boolean;
  sourcePriceItemId: string | null;
}

interface ScenarioApi {
  id: string;
  nome: string;
  horizonteMeses: number;
  itens: ScenarioItemApi[];
}

interface PriceMonitorItemLite {
  id: string;
  title: string;
  referencePriceCents: number | null;
  lastBestPriceCents: number | null;
}

const HORIZONTES: PurchasePlanHorizonte[] = [3, 6, 12];

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const emptyItemForm = {
  nome: '',
  tipo: 'A_VISTA' as ScenarioItemApi['tipo'],
  valor: '',
  entrada: '',
  parcelas: '',
  taxaJuros: '',
  sistema: 'PRICE' as NonNullable<ScenarioItemApi['sistema']>,
  mesInicio: currentMonth(),
};

export default function PlanejadorPage() {
  const params = useParams();
  const projectId = String(params?.projectId ?? '');
  const { projectType } = useProject();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const enabled = hasFeature(projectType as ProjectType, 'monthlyOverview');

  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const [newScenarioName, setNewScenarioName] = useState('');
  const [itemForm, setItemForm] = useState(emptyItemForm);
  const [horizonte, setHorizonte] = useState<PurchasePlanHorizonte>(6);

  // Deep-link da COMPRA: ?priceItemId=X&projectId=Y (Y = projeto COMPRA dono do item).
  const priceItemId = searchParams.get('priceItemId');
  const sourceProjectId = searchParams.get('projectId');

  const scenariosQuery = useQuery<ScenarioApi[]>({
    queryKey: ['planejador', projectId],
    queryFn: () => api.get(`/projects/${projectId}/planejador`),
    enabled: enabled && !!projectId,
  });

  const month = currentMonth();
  const dreOverviewQuery = useQuery<DreOverviewResponse>({
    queryKey: ['dre-overview', projectId, month],
    queryFn: () =>
      api.get(`/projects/${projectId}/monthly-overview/dre-overview?month=${month}&year=${new Date().getFullYear()}`),
    enabled: enabled && !!projectId,
  });

  const sourceItemQuery = useQuery<PriceMonitorItemLite[]>({
    queryKey: ['price-monitor', sourceProjectId],
    queryFn: () => api.get(`/projects/${sourceProjectId}/price-monitor/items`),
    enabled: enabled && !!sourceProjectId && !!priceItemId,
  });

  const scenarios = scenariosQuery.data ?? [];
  const selectedScenario = scenarios.find((s) => s.id === selectedScenarioId) ?? scenarios[0] ?? null;

  useEffect(() => {
    if (!selectedScenarioId && scenarios.length > 0) setSelectedScenarioId(scenarios[0]!.id);
  }, [scenarios, selectedScenarioId]);

  useEffect(() => {
    if (selectedScenario) setHorizonte(selectedScenario.horizonteMeses as PurchasePlanHorizonte);
  }, [selectedScenario?.id]);

  // Pré-carrega nome+preço do item monitorado (fallback: preço de referência).
  useEffect(() => {
    if (!priceItemId) return;
    const sourceItem = sourceItemQuery.data?.find((i) => i.id === priceItemId);
    if (!sourceItem) return;
    const priceCents = sourceItem.lastBestPriceCents ?? sourceItem.referencePriceCents ?? 0;
    setItemForm((current) => ({
      ...current,
      nome: sourceItem.title,
      valor: centsToReaisInput(priceCents),
    }));
  }, [priceItemId, sourceItemQuery.data]);

  const createScenario = useMutation({
    mutationFn: (nome: string) => api.post<ScenarioApi>(`/projects/${projectId}/planejador`, { nome }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['planejador', projectId] });
      setSelectedScenarioId(created.id);
      setNewScenarioName('');
    },
  });

  const updateScenarioHorizonte = useMutation({
    mutationFn: (h: PurchasePlanHorizonte) =>
      api.patch(`/projects/${projectId}/planejador/${selectedScenario!.id}`, { horizonteMeses: h }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['planejador', projectId] }),
  });

  const createItem = useMutation({
    mutationFn: () => {
      const tipo = itemForm.tipo;
      return api.post(`/projects/${projectId}/planejador/${selectedScenario!.id}/itens`, {
        nome: itemForm.nome,
        tipo,
        valorCents: currencyInputToCents(itemForm.valor),
        mesInicio: itemForm.mesInicio,
        entradaCents: tipo === 'FINANCIAMENTO' ? currencyInputToCents(itemForm.entrada || '0') : undefined,
        parcelas: tipo !== 'A_VISTA' ? Number(itemForm.parcelas) : undefined,
        taxaJurosMensalBps:
          tipo === 'FINANCIAMENTO' ? Math.round(Number(itemForm.taxaJuros.replace(',', '.') || 0) * 100) : undefined,
        sistema: tipo === 'FINANCIAMENTO' ? itemForm.sistema : undefined,
        sourcePriceItemId: priceItemId ?? undefined,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['planejador', projectId] });
      setItemForm(emptyItemForm);
    },
  });

  const toggleItem = useMutation({
    mutationFn: (item: ScenarioItemApi) =>
      api.patch(`/projects/${projectId}/planejador/${selectedScenario!.id}/itens/${item.id}`, {
        incluido: !item.incluido,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['planejador', projectId] }),
  });

  const removeItem = useMutation({
    mutationFn: (itemId: string) =>
      api.delete(`/projects/${projectId}/planejador/${selectedScenario!.id}/itens/${itemId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['planejador', projectId] }),
  });

  const baseline = useMemo(
    () =>
      (dreOverviewQuery.data?.anual?.saldoAcumuladoSerie ?? [])
        .filter((row) => row.mes >= month)
        .map((row) => ({ mes: row.mes, saldoProjetadoCents: row.saldoProjetado })),
    [dreOverviewQuery.data, month],
  );

  const planItens: PurchasePlanItem[] = useMemo(
    () =>
      (selectedScenario?.itens ?? []).map((i) => ({
        tipo: i.tipo,
        valorCents: i.valorCents,
        mesInicio: i.mesInicio,
        incluido: i.incluido,
        parcelas: i.parcelas ?? undefined,
        entradaCents: i.entradaCents ?? undefined,
        taxaJurosMensalBps: i.taxaJurosMensalBps ?? undefined,
        sistema: i.sistema ?? undefined,
      })),
    [selectedScenario],
  );

  if (!enabled) {
    return (
      <div className="rounded-2xl border border-lifeone-hairline bg-lifeone-card p-5 text-sm text-lifeone-ink-2">
        O Planejador de Compras só está disponível no projeto Pessoal.
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4" style={COCKPIT_THEME}>
      <header className="flex items-center gap-3">
        <Calculator className="h-7 w-7 text-[var(--ck-accent)]" />
        <div>
          <h1 className="text-2xl font-semibold text-[var(--ck-text)]">Planejador de Compras</h1>
          <p className="text-sm text-[var(--ck-muted)]">
            Simule à vista, parcelado ou financiamento sobre a projeção do Pessoal — sem afetar o caixa real.
          </p>
        </div>
      </header>

      <Card title="Cenário">
        <div className="flex flex-wrap items-center gap-2">
          {scenarios.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelectedScenarioId(s.id)}
              className={`min-h-[44px] rounded-full border px-4 text-sm font-medium ${
                s.id === selectedScenario?.id
                  ? 'border-[var(--ck-accent)] bg-[var(--ck-accent)]/10 text-[var(--ck-accent)]'
                  : 'border-[var(--ck-border)] text-[var(--ck-muted)]'
              }`}
            >
              {s.nome}
            </button>
          ))}
          <Input
            placeholder="Novo cenário (ex.: Carro novo)"
            value={newScenarioName}
            onChange={(e) => setNewScenarioName(e.target.value)}
            className="max-w-[220px]"
          />
          <Button
            type="button"
            disabled={!newScenarioName.trim() || createScenario.isPending}
            onClick={() => createScenario.mutate(newScenarioName.trim())}
          >
            <Plus className="h-4 w-4" /> Criar cenário
          </Button>
        </div>
      </Card>

      {selectedScenario && (
        <>
          <Card title="Horizonte">
            <div className="flex gap-2">
              {HORIZONTES.map((h) => (
                <button
                  key={h}
                  type="button"
                  data-testid={`horizonte-${h}`}
                  onClick={() => {
                    setHorizonte(h);
                    updateScenarioHorizonte.mutate(h);
                  }}
                  className={`min-h-[44px] min-w-[44px] rounded-full border px-4 text-sm font-semibold ${
                    horizonte === h
                      ? 'border-[var(--ck-accent)] bg-[var(--ck-accent)]/10 text-[var(--ck-accent)]'
                      : 'border-[var(--ck-border)] text-[var(--ck-muted)]'
                  }`}
                >
                  {h}m
                </button>
              ))}
            </div>
          </Card>

          {dreOverviewQuery.data && (
            <PlanVeredito baseline={baseline} itens={planItens} horizonte={horizonte} />
          )}

          <Card title="Itens do cenário">
            <ul className="space-y-2">
              {selectedScenario.itens.map((item) => (
                <li
                  key={item.id}
                  data-testid={`item-${item.id}`}
                  className="flex items-center justify-between gap-2 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] px-3 py-2"
                >
                  <label className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={item.incluido}
                      onChange={() => toggleItem.mutate(item)}
                      className="h-5 w-5"
                      aria-label={`Incluir ${item.nome} no veredito`}
                    />
                    <span className="min-w-0 truncate text-sm text-[var(--ck-text)]">
                      {item.nome} · {item.tipo === 'A_VISTA' ? 'à vista' : item.tipo === 'PARCELADO' ? `${item.parcelas}x` : `financ. ${item.sistema}`}
                    </span>
                  </label>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-geist text-sm font-bold tabular-nums text-[var(--ck-text)]">
                      {moneyGlance(item.valorCents)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Excluir ${item.nome}`}
                      onClick={() => removeItem.mutate(item.id)}
                      className="min-h-[44px] min-w-[44px] text-[var(--ck-muted)] hover:text-[var(--ck-neg)]"
                    >
                      <Trash2 className="mx-auto h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
              {selectedScenario.itens.length === 0 && (
                <p className="text-sm text-[var(--ck-muted)]">Nenhum item ainda — adicione abaixo.</p>
              )}
            </ul>

            <form
              className="mt-4 grid gap-3 border-t border-[var(--ck-border)] pt-4 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                createItem.mutate();
              }}
            >
              <Input
                id="item-nome"
                label="Nome"
                value={itemForm.nome}
                onChange={(e) => setItemForm((f) => ({ ...f, nome: e.target.value }))}
                required
              />
              <Select
                id="item-tipo"
                label="Tipo"
                value={itemForm.tipo}
                options={[
                  { value: 'A_VISTA', label: 'À vista' },
                  { value: 'PARCELADO', label: 'Parcelado' },
                  { value: 'FINANCIAMENTO', label: 'Financiamento' },
                ]}
                onChange={(e) => setItemForm((f) => ({ ...f, tipo: e.target.value as ScenarioItemApi['tipo'] }))}
                required
              />
              <Input
                id="item-valor"
                label="Valor (R$)"
                value={itemForm.valor}
                onChange={(e) => setItemForm((f) => ({ ...f, valor: maskCurrencyInput(e.target.value) }))}
                required
              />
              <Input
                id="item-mes-inicio"
                label="Mês de início"
                type="month"
                value={itemForm.mesInicio}
                onChange={(e) => setItemForm((f) => ({ ...f, mesInicio: e.target.value }))}
                required
              />
              {itemForm.tipo !== 'A_VISTA' && (
                <Input
                  id="item-parcelas"
                  label="Parcelas"
                  type="number"
                  min={1}
                  value={itemForm.parcelas}
                  onChange={(e) => setItemForm((f) => ({ ...f, parcelas: e.target.value }))}
                  required
                />
              )}
              {itemForm.tipo === 'FINANCIAMENTO' && (
                <>
                  <Input
                    id="item-entrada"
                    label="Entrada (R$)"
                    value={itemForm.entrada}
                    onChange={(e) => setItemForm((f) => ({ ...f, entrada: maskCurrencyInput(e.target.value) }))}
                  />
                  <Input
                    id="item-taxa-juros"
                    label="Taxa mensal (%)"
                    value={itemForm.taxaJuros}
                    onChange={(e) => setItemForm((f) => ({ ...f, taxaJuros: e.target.value }))}
                  />
                  <Select
                    id="item-sistema"
                    label="Sistema"
                    value={itemForm.sistema}
                    options={[{ value: 'PRICE', label: 'PRICE' }, { value: 'SAC', label: 'SAC' }]}
                    onChange={(e) => setItemForm((f) => ({ ...f, sistema: e.target.value as 'PRICE' | 'SAC' }))}
                    required
                  />
                </>
              )}
              <div className="sm:col-span-2">
                <Button type="submit" disabled={createItem.isPending || !itemForm.nome.trim() || !itemForm.valor}>
                  <Plus className="h-4 w-4" /> Adicionar item
                </Button>
              </div>
            </form>
          </Card>
        </>
      )}

      {scenarios.length === 0 && !scenariosQuery.isLoading && (
        <p className="text-sm text-[var(--ck-muted)]">Crie um cenário para começar a simular.</p>
      )}
    </div>
  );
}
