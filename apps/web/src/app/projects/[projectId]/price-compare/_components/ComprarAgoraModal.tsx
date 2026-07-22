'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';

interface ComprarAgoraItem {
  id: string;
  title: string;
  lastBestPriceCents: number | null;
  lastBestPrice?: number | null;
  referencePriceCents: number | null;
}

interface ComprarAgoraModalProps {
  item: ComprarAgoraItem | null;
  projectId: string;
  onClose: () => void;
}

const PAYMENT_OPTIONS = [
  { value: 'A_VISTA', label: 'À vista' },
  { value: 'PARCELADO', label: 'Parcelado' },
];

function todayInputValue() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function ComprarAgoraModal({ item, projectId, onClose }: ComprarAgoraModalProps) {
  const queryClient = useQueryClient();
  const [quantidade, setQuantidade] = useState('1');
  const [formaPagamento, setFormaPagamento] = useState('A_VISTA');
  const [parcelas, setParcelas] = useState('2');
  const [dataCompra, setDataCompra] = useState(todayInputValue);
  const [dataInicio, setDataInicio] = useState(todayInputValue);

  useEffect(() => {
    if (!item) return;
    setQuantidade('1');
    setFormaPagamento('A_VISTA');
    setParcelas('2');
    setDataCompra(todayInputValue());
    setDataInicio(todayInputValue());
  }, [item]);

  const priceCents =
    item?.lastBestPriceCents ??
    (item?.lastBestPrice ? Math.round(item.lastBestPrice * 100) : null) ??
    item?.referencePriceCents ??
    null;

  const mutation = useMutation({
    mutationFn: () => {
      if (!item || !priceCents) {
        throw new Error('Atualize ou informe um preço antes de comprar');
      }

      return api.post(`/projects/${projectId}/price-monitor/items/${item.id}/comprar-agora`, {
        quantidade: Number(quantidade),
        formaPagamento,
        parcelas: formaPagamento === 'PARCELADO' ? Number(parcelas) : undefined,
        dataCompra,
        dataInicio: formaPagamento === 'PARCELADO' ? dataInicio : undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['price-monitor', projectId],
      });
      queryClient.invalidateQueries({ queryKey: ['expenses', projectId] });
      toast.success('Compra registrada e monitoramento encerrado');
      onClose();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Falha ao registrar compra');
    },
  });

  if (!item) return null;

  return (
    <Modal open onClose={onClose} title="Comprar agora" size="sm">
      <div className="space-y-4">
        <div className="rounded-xl bg-darc-linen/40 p-3">
          <p className="text-sm font-semibold text-darc-velvet">{item.title}</p>
          <p className="mt-1 text-xl font-bold text-darc-velvet">
            {priceCents ? formatCurrency(priceCents / 100) : 'Sem preço'}
          </p>
        </div>

        <Input
          id="buy-quantity"
          label="Quantidade"
          type="number"
          min={1}
          step={1}
          value={quantidade}
          onChange={(event) => setQuantidade(event.target.value)}
        />

        <Select
          id="buy-payment"
          label="Forma de pagamento"
          value={formaPagamento}
          onChange={(event) => setFormaPagamento(event.target.value)}
          options={PAYMENT_OPTIONS}
        />

        {formaPagamento === 'PARCELADO' && (
          <Input
            id="buy-installments"
            label="Parcelas"
            type="number"
            min={2}
            max={360}
            step={1}
            value={parcelas}
            onChange={(event) => setParcelas(event.target.value)}
          />
        )}

        <Input
          id="buy-date"
          label="Data da compra"
          type="date"
          value={dataCompra}
          onChange={(event) => setDataCompra(event.target.value)}
        />

        {formaPagamento === 'PARCELADO' && (
          <Input
            id="buy-installments-start"
            label="Início das parcelas"
            type="date"
            value={dataInicio}
            onChange={(event) => setDataInicio(event.target.value)}
          />
        )}

        <p className="text-xs leading-5 text-darc-velvet/65">
          A compra será lançada em Despesas e este monitoramento será encerrado.
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" className="min-h-11" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={
              mutation.isPending ||
              !priceCents ||
              Number(quantidade) < 1 ||
              (formaPagamento === 'PARCELADO' && Number(parcelas) < 2)
            }
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Registrando…' : 'Registrar compra'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
