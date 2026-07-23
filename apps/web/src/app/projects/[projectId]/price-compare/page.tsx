'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { hasFeature, type ProjectType } from '@reformaflow/domain';
import { RefreshCcw, Plus, Trash2, ExternalLink, Edit, ShoppingCart, Calculator } from 'lucide-react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { currencyInputToCents, maskCurrencyInput } from '@/lib/currency-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { EditAlertModal } from './_components/EditAlertModal';
import { ComprarAgoraModal } from './_components/ComprarAgoraModal';

interface PriceMonitorItem {
  id: string;
  title: string;
  query: string | null;
  productUrl: string | null;
  notes: string | null;
  referencePriceCents: number | null;
  targetPriceCents: number | null;
  isActive: boolean;
  lastBestPriceCents: number | null;
  lastBestPrice: number | null;
  lastBestStore: string | null;
  lastBestLink: string | null;
  lastCheckedAt: string | null;
  monitoringEndDate: string | null;
  diasMonitoramento: number;
}

interface RefreshAllResponse {
  refreshedCount?: number;
}

export default function PriceComparePage() {
  const { projectId, projectType } = useProject();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [query, setQuery] = useState('');
  const [productUrl, setProductUrl] = useState('');
  const [referencePrice, setReferencePrice] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [buyingItemId, setBuyingItemId] = useState<string | null>(null);

  const enabled = hasFeature(projectType as ProjectType, 'priceCompare');

  const { data: items = [], isLoading } = useQuery<PriceMonitorItem[]>({
    queryKey: ['price-monitor', projectId],
    queryFn: () => api.get(`/projects/${projectId}/price-monitor/items`),
    enabled,
  });

  // Projeto Pessoal do tenant — destino do deep-link "Simular impacto" (o
  // Planejador vive só lá; reusa a mesma lista de /projects já usada por
  // outras telas para cross-project linking).
  const { data: tenantProjects = [] } = useQuery<{ id: string; type: string }[]>({
    queryKey: ['tenant', 'projects'],
    queryFn: () => api.get('/projects'),
    staleTime: 60_000,
  });
  const pessoalProjectId = tenantProjects.find((p) => p.type === 'PESSOAL')?.id;

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error('Informe o nome do produto');
      const payload = {
        title: title.trim(),
        query: query.trim() || undefined,
        productUrl: productUrl.trim() || undefined,
        referencePriceCents: currencyInputToCents(referencePrice) || undefined,
        targetPriceCents: currencyInputToCents(targetPrice) || undefined,
      };
      return api.post(`/projects/${projectId}/price-monitor/items`, payload);
    },
    onSuccess: () => {
      setTitle('');
      setQuery('');
      setProductUrl('');
      setReferencePrice('');
      setTargetPrice('');
      queryClient.invalidateQueries({ queryKey: ['price-monitor', projectId] });
      toast.success('Produto adicionado ao monitoramento');
    },
    onError: (error: Error) => toast.error(error.message || 'Falha ao cadastrar produto'),
  });

  const refreshOneMutation = useMutation({
    mutationFn: (itemId: string) =>
      api.post(`/projects/${projectId}/price-monitor/items/${itemId}/refresh`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['price-monitor', projectId] });
      toast.success('Preço atualizado');
    },
    onError: () => toast.error('Falha ao atualizar preço'),
  });

  const refreshAllMutation = useMutation({
    mutationFn: () =>
      api.post<RefreshAllResponse>(`/projects/${projectId}/price-monitor/refresh`, {}),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['price-monitor', projectId] });
      toast.success(`${res?.refreshedCount ?? 0} produto(s) atualizado(s)`);
    },
    onError: () => toast.error('Falha ao atualizar monitoramento'),
  });

  const deleteMutation = useMutation({
    mutationFn: (itemId: string) =>
      api.delete(`/projects/${projectId}/price-monitor/items/${itemId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['price-monitor', projectId] });
      toast.success('Produto removido');
    },
    onError: () => toast.error('Falha ao remover produto'),
  });

  if (!enabled) {
    return (
      <div className="rounded-2xl border border-darc-linen bg-white p-5 text-sm text-darc-velvet/80">
        Monitoramento de preço não está disponível para este tipo de projeto.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-editorial italic text-2xl text-darc-velvet">
          Monitoramento de preços
        </h1>
        <p className="text-sm text-darc-velvet/70">
          Cadastre produtos da sua lista e acompanhe o melhor preço encontrado.
        </p>
      </div>

      <div className="rounded-2xl border border-darc-linen bg-white p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Input
            label="Produto"
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex.: Geladeira Frost Free 450L"
          />
          <Input
            label="Termo de busca (opcional)"
            name="query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ex.: geladeira frost free 450l inverter"
          />
          <Input
            label="Link de referência (opcional)"
            name="productUrl"
            value={productUrl}
            onChange={(e) => setProductUrl(e.target.value)}
            placeholder="https://..."
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              label="Preço atual"
              name="referencePrice"
              inputMode="numeric"
              value={referencePrice}
              onChange={(e) => setReferencePrice(maskCurrencyInput(e.target.value))}
              placeholder="0,00"
            />
            <Input
              label="Preço alvo"
              name="targetPrice"
              inputMode="numeric"
              value={targetPrice}
              onChange={(e) => setTargetPrice(maskCurrencyInput(e.target.value))}
              placeholder="0,00"
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            type="button"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            <Plus className="h-4 w-4" /> Adicionar ao monitoramento
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-darc-velvet">
          Itens monitorados ({items.length})
        </h2>
        <Button
          type="button"
          variant="secondary"
          onClick={() => refreshAllMutation.mutate()}
          disabled={refreshAllMutation.isPending || items.length === 0}
        >
          <RefreshCcw className="h-4 w-4" /> Atualizar todos
        </Button>
      </div>

      {isLoading && <p className="text-sm text-darc-velvet/60">Carregando produtos...</p>}

      {!isLoading && items.length === 0 && (
        <div className="rounded-2xl border border-darc-linen bg-white p-5 text-sm text-darc-velvet/70">
          Nenhum produto monitorado ainda.
        </div>
      )}

      <div className="space-y-3">
        {items.map((item) => {
          const deltaCents =
            item.referencePriceCents != null && item.lastBestPriceCents != null
              ? item.lastBestPriceCents - item.referencePriceCents
              : null;
          const canBuy =
            item.isActive &&
            (!item.monitoringEndDate ||
              new Date(item.monitoringEndDate).getTime() > Date.now());

          return (
            <div key={item.id} className="rounded-2xl border border-darc-linen bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-darc-velvet">{item.title}</p>
                  <p className="text-xs text-darc-velvet/60">
                    Busca: {item.query || item.title}
                  </p>
                  {item.lastCheckedAt && (
                    <p className="text-xs text-darc-velvet/50">
                      Última checagem: {new Date(item.lastCheckedAt).toLocaleString('pt-BR')}
                    </p>
                  )}
                </div>

                <div className="text-right">
                  <p className="text-xs text-darc-velvet/60">Melhor preço</p>
                  <p className="text-base font-bold text-darc-velvet">
                    {item.lastBestPriceCents != null
                      ? formatCurrency(item.lastBestPriceCents / 100)
                      : '—'}
                  </p>
                  {deltaCents != null && (
                    <p
                      className={`text-xs font-medium ${
                        deltaCents <= 0 ? 'text-green-700' : 'text-red-700'
                      }`}
                    >
                      {deltaCents <= 0 ? '↓' : '↑'} {formatCurrency(Math.abs(deltaCents) / 100)}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-darc-velvet/70">
                {item.referencePriceCents != null && (
                  <span>Referência: {formatCurrency(item.referencePriceCents / 100)}</span>
                )}
                {item.targetPriceCents != null && (
                  <span>Alvo: {formatCurrency(item.targetPriceCents / 100)}</span>
                )}
                {item.lastBestStore && <span>Loja: {item.lastBestStore}</span>}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {canBuy &&
                  (item.lastBestPriceCents != null ||
                    item.lastBestPrice != null ||
                    item.referencePriceCents != null) && (
                    <Button
                      type="button"
                      className="min-h-11"
                      onClick={() => setBuyingItemId(item.id)}
                    >
                      <ShoppingCart className="h-4 w-4" /> Comprar agora
                    </Button>
                  )}
                {pessoalProjectId && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      router.push(
                        `/projects/${pessoalProjectId}/planejador?priceItemId=${item.id}&projectId=${projectId}`,
                      )
                    }
                  >
                    <Calculator className="h-4 w-4" /> Simular impacto
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setEditingItemId(item.id)}
                >
                  <Edit className="h-4 w-4" /> Editar
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => refreshOneMutation.mutate(item.id)}
                  disabled={refreshOneMutation.isPending}
                >
                  <RefreshCcw className="h-4 w-4" /> Atualizar
                </Button>
                {item.lastBestLink && (
                  <a
                    href={item.lastBestLink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-darc-linen px-3 py-2 text-xs font-medium text-darc-velvet hover:bg-darc-linen/30"
                  >
                    <ExternalLink className="h-4 w-4" /> Ver oferta
                  </a>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => deleteMutation.mutate(item.id)}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="h-4 w-4" /> Remover
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {editingItemId && (
        <EditAlertModal
          open={true}
          onClose={() => setEditingItemId(null)}
          item={items.find((i) => i.id === editingItemId) || null}
          projectId={projectId}
        />
      )}

      <ComprarAgoraModal
        item={
          items.find((item) => item.id === buyingItemId) ?? null
        }
        projectId={projectId}
        onClose={() => setBuyingItemId(null)}
      />
    </div>
  );
}
