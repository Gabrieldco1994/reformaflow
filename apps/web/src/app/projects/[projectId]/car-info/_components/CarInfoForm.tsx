'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Save, Car } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface CarInfo {
  id?: string;
  marca: string;
  modelo: string;
  anoFabricacao: number | null;
  anoModelo: number | null;
  cor: string;
  placa: string;
  tabelaFipe: number | null;
  valorPago: number | null;
  kmAtual: number | null;
  kmUltimaRevisao: number | null;
}

const emptyCarInfo: CarInfo = {
  marca: '', modelo: '', anoFabricacao: null, anoModelo: null,
  cor: '', placa: '', tabelaFipe: null, valorPago: null,
  kmAtual: null, kmUltimaRevisao: null,
};

interface CarInfoFormProps {
  projectId: string;
}

export function CarInfoForm({ projectId }: CarInfoFormProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CarInfo>(emptyCarInfo);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery<CarInfo | null>({
    queryKey: ['car-info', projectId],
    queryFn: () => api.get(`/projects/${projectId}/car-info`),
  });

  useEffect(() => {
    if (data) {
      setForm(data);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.put(`/projects/${projectId}/car-info`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['car-info', projectId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const handleSave = () => {
    saveMutation.mutate({
      marca: form.marca || undefined,
      modelo: form.modelo || undefined,
      anoFabricacao: form.anoFabricacao || undefined,
      anoModelo: form.anoModelo || undefined,
      cor: form.cor || undefined,
      placa: form.placa ? form.placa.toUpperCase() : undefined,
      tabelaFipe: form.tabelaFipe || undefined,
      valorPago: form.valorPago || undefined,
      kmAtual: form.kmAtual || undefined,
      kmUltimaRevisao: form.kmUltimaRevisao || undefined,
    });
  };

  const setField = (key: keyof CarInfo, value: string) => {
    if (['anoFabricacao', 'anoModelo', 'tabelaFipe', 'valorPago', 'kmAtual', 'kmUltimaRevisao'].includes(key)) {
      setForm((f) => ({ ...f, [key]: value === '' ? null : parseInt(value, 10) }));
    } else {
      setForm((f) => ({ ...f, [key]: value }));
    }
  };

  if (isLoading) return <div className="text-gray-500">Carregando...</div>;

  const kmDiff = (form.kmAtual && form.kmUltimaRevisao)
    ? form.kmAtual - form.kmUltimaRevisao
    : null;

  return (
    <div className="space-y-8 w-full max-w-2xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <Car className="w-7 h-7 text-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900">Meu Carro</h1>
        </div>
        <Button onClick={handleSave} disabled={saveMutation.isPending}>
          <Save className="w-4 h-4 mr-2" />
          {saved ? '✓ Salvo!' : saveMutation.isPending ? 'Salvando...' : 'Salvar'}
        </Button>
      </div>

      {/* Identificação */}
      <section className="border rounded-xl p-5 space-y-4">
        <h2 className="text-lg font-semibold text-gray-800">🚗 Identificação</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Marca</label>
            <Input
              placeholder="Ex: Toyota"
              value={form.marca}
              onChange={(e) => setField('marca', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Modelo</label>
            <Input
              placeholder="Ex: Corolla XEi"
              value={form.modelo}
              onChange={(e) => setField('modelo', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Ano Fabricação</label>
            <Input
              type="number"
              placeholder="Ex: 2023"
              value={form.anoFabricacao ?? ''}
              onChange={(e) => setField('anoFabricacao', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Ano Modelo</label>
            <Input
              type="number"
              placeholder="Ex: 2024"
              value={form.anoModelo ?? ''}
              onChange={(e) => setField('anoModelo', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Cor</label>
            <Input
              placeholder="Ex: Branco Pérola"
              value={form.cor}
              onChange={(e) => setField('cor', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Placa</label>
            <Input
              placeholder="Ex: ABC1D23"
              value={form.placa}
              onChange={(e) => setField('placa', e.target.value.toUpperCase())}
              maxLength={7}
              className="uppercase"
            />
          </div>
        </div>
      </section>

      {/* Valores */}
      <section className="border rounded-xl p-5 space-y-4">
        <h2 className="text-lg font-semibold text-gray-800">💰 Valores</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Tabela FIPE (R$)</label>
            <Input
              type="number"
              placeholder="Ex: 12000000 (em centavos)"
              value={form.tabelaFipe ?? ''}
              onChange={(e) => setField('tabelaFipe', e.target.value)}
            />
            {form.tabelaFipe != null && (
              <p className="text-xs text-gray-400 mt-1">{formatCurrency(form.tabelaFipe / 100)}</p>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Valor Pago (R$)</label>
            <Input
              type="number"
              placeholder="Ex: 11500000 (em centavos)"
              value={form.valorPago ?? ''}
              onChange={(e) => setField('valorPago', e.target.value)}
            />
            {form.valorPago != null && (
              <p className="text-xs text-gray-400 mt-1">{formatCurrency(form.valorPago / 100)}</p>
            )}
          </div>
        </div>
        {form.tabelaFipe != null && form.valorPago != null && (
          <div className={`rounded-lg p-3 text-sm ${
            form.valorPago <= form.tabelaFipe
              ? 'bg-green-50 text-green-700'
              : 'bg-red-50 text-red-700'
          }`}>
            {form.valorPago <= form.tabelaFipe
              ? `✅ Pagou ${formatCurrency((form.tabelaFipe - form.valorPago) / 100)} abaixo da FIPE`
              : `⚠️ Pagou ${formatCurrency((form.valorPago - form.tabelaFipe) / 100)} acima da FIPE`
            }
          </div>
        )}
      </section>

      {/* Quilometragem */}
      <section className="border rounded-xl p-5 space-y-4">
        <h2 className="text-lg font-semibold text-gray-800">📏 Quilometragem</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">KM Atual</label>
            <Input
              type="number"
              placeholder="Ex: 45000"
              value={form.kmAtual ?? ''}
              onChange={(e) => setField('kmAtual', e.target.value)}
            />
            {form.kmAtual != null && (
              <p className="text-xs text-gray-400 mt-1">{form.kmAtual.toLocaleString('pt-BR')} km</p>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">KM Última Revisão</label>
            <Input
              type="number"
              placeholder="Ex: 40000"
              value={form.kmUltimaRevisao ?? ''}
              onChange={(e) => setField('kmUltimaRevisao', e.target.value)}
            />
            {form.kmUltimaRevisao != null && (
              <p className="text-xs text-gray-400 mt-1">{form.kmUltimaRevisao.toLocaleString('pt-BR')} km</p>
            )}
          </div>
        </div>
        {kmDiff != null && (
          <div className={`rounded-lg p-3 text-sm ${
            kmDiff >= 10000
              ? 'bg-red-50 text-red-700'
              : kmDiff >= 7000
                ? 'bg-yellow-50 text-yellow-700'
                : 'bg-green-50 text-green-700'
          }`}>
            {kmDiff >= 10000
              ? `⚠️ ${kmDiff.toLocaleString('pt-BR')} km desde a última revisão — hora de revisar!`
              : kmDiff >= 7000
                ? `🔶 ${kmDiff.toLocaleString('pt-BR')} km desde a última revisão — revisão se aproximando`
                : `✅ ${kmDiff.toLocaleString('pt-BR')} km desde a última revisão`
            }
          </div>
        )}
      </section>
    </div>
  );
}
