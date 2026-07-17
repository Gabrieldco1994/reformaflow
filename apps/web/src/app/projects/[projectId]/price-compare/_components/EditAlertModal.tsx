'use client';

import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { currencyInputToCents, maskCurrencyInput, centsToReaisInput } from '@/lib/currency-input';
import { toast } from 'sonner';

interface EditAlertModalProps {
  open: boolean;
  onClose: () => void;
  item: {
    id: string;
    title: string;
    productUrl: string | null;
    targetPriceCents: number | null;
    diasMonitoramento: number;
    notes: string | null;
  } | null;
  projectId: string;
}

const DIAS_OPTIONS = [
  { value: '7', label: '7 dias' },
  { value: '14', label: '14 dias' },
  { value: '30', label: '30 dias' },
  { value: '60', label: '60 dias' },
  { value: '90', label: '90 dias' },
  { value: '180', label: '180 dias' },
  { value: '365', label: '365 dias' },
];

export function EditAlertModal({ open, onClose, item, projectId }: EditAlertModalProps) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [diasMonitoramento, setDiasMonitoramento] = useState('30');
  const [notes, setNotes] = useState('');

  // Initialize form when item changes
  useEffect(() => {
    if (item && open) {
      setTitle(item.title);
      setUrl(item.productUrl || '');
      setTargetPrice(centsToReaisInput(item.targetPriceCents || 0));
      setDiasMonitoramento(String(item.diasMonitoramento));
      setNotes(item.notes || '');
    }
  }, [item, open]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error('Nenhum item selecionado');
      if (!title.trim()) throw new Error('Informe o título');

      const dias = parseInt(diasMonitoramento, 10);
      if (dias < 1 || dias > 365) throw new Error('Dias deve estar entre 1 e 365');

      const targetPriceCents = currencyInputToCents(targetPrice);
      if (targetPrice.trim() && targetPriceCents <= 0) {
        throw new Error('Preço-alvo deve ser maior que 0');
      }

      return api.patch(`/projects/${projectId}/price-monitor/items/${item.id}`, {
        title: title.trim(),
        productUrl: url.trim() || undefined,
        targetPriceCents: targetPrice.trim() ? targetPriceCents : null,
        diasMonitoramento: dias,
        notes: notes.trim() || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['price-monitor', projectId] });
      toast.success('Alerta atualizado');
      handleClose();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Falha ao atualizar alerta');
    },
  });

  const handleClose = () => {
    setTitle('');
    setUrl('');
    setTargetPrice('');
    setDiasMonitoramento('30');
    setNotes('');
    onClose();
  };

  if (!item) return null;

  return (
    <Modal open={open} onClose={handleClose} title="Editar Alerta de Preço" size="md">
      <div className="space-y-4">
        <Input
          id="edit-title"
          label="Título do Produto"
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Ex.: Geladeira Frost Free"
        />

        <Input
          id="edit-productUrl"
          label="URL do Produto (opcional)"
          name="productUrl"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
        />

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-1">
          <Input
            id="edit-targetPrice"
            label="Preço-Alvo (opcional)"
            name="targetPrice"
            inputMode="numeric"
            value={targetPrice}
            onChange={(e) => setTargetPrice(maskCurrencyInput(e.target.value))}
            placeholder="0,00"
          />
          <Select
            label="Dias de Monitoramento"
            id="edit-diasMonitoramento"
            name="diasMonitoramento"
            value={diasMonitoramento}
            onChange={(e) => setDiasMonitoramento(e.target.value)}
            options={DIAS_OPTIONS}
          />
        </div>

        <Input
          id="edit-notes"
          label="Notas (opcional)"
          name="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Adicione observações sobre este produto"
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={() => updateMutation.mutate()}
            disabled={updateMutation.isPending}
          >
            Salvar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
