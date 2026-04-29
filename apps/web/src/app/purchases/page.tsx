'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { Plus, Trash2, ShoppingCart } from 'lucide-react';
import { useState } from 'react';

const PROJECT_ID = 'demo-project';

const paymentMethods = [
  { value: 'PIX', label: 'PIX' },
  { value: 'CREDIT_CARD', label: 'Cartão de Crédito' },
  { value: 'DEBIT_CARD', label: 'Cartão de Débito' },
  { value: 'BANK_TRANSFER', label: 'Transferência' },
  { value: 'BOLETO', label: 'Boleto' },
  { value: 'CASH', label: 'Dinheiro' },
];

interface Purchase {
  id: string;
  date: string;
  item: string;
  room: { name: string };
  workType: { name: string };
  store: string | null;
  paymentMethod: string;
  totalAmount: number;
  installments: number;
  hasInvoice: boolean;
}

export default function PurchasesPage() {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);

  const { data: purchases = [] } = useQuery<Purchase[]>({
    queryKey: ['purchases', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/purchases`),
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.post(`/projects/${PROJECT_ID}/purchases`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['purchases'] });
      queryClient.invalidateQueries({ queryKey: ['budget-items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setModalOpen(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${PROJECT_ID}/purchases/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['purchases'] });
      queryClient.invalidateQueries({ queryKey: ['budget-items'] });
    },
  });

  const mockPurchases: Purchase[] = [
    { id: '1', date: '2026-05-10', item: 'Porcelanato 60x60', room: { name: 'Cozinha' }, workType: { name: 'Pisos/Revestimentos' }, store: 'Leroy Merlin', paymentMethod: 'CREDIT_CARD', totalAmount: 2500, installments: 3, hasInvoice: true },
    { id: '2', date: '2026-05-12', item: 'Fiação 2.5mm', room: { name: 'Sala de TV' }, workType: { name: 'Elétrica' }, store: 'Elétrica Center', paymentMethod: 'PIX', totalAmount: 800, installments: 1, hasInvoice: true },
    { id: '3', date: '2026-05-15', item: 'Tinta Suvinil Fosca', room: { name: 'Cozinha' }, workType: { name: 'Pintura' }, store: 'Tintas MC', paymentMethod: 'PIX', totalAmount: 450, installments: 1, hasInvoice: false },
  ];

  const displayPurchases = purchases.length > 0 ? purchases : mockPurchases;
  const total = displayPurchases.reduce((s, p) => s + p.totalAmount, 0);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createMutation.mutate({
      date: formData.get('date'),
      item: formData.get('item'),
      roomId: formData.get('roomId'),
      workTypeId: formData.get('workTypeId'),
      store: formData.get('store') || undefined,
      paymentMethod: formData.get('paymentMethod'),
      totalAmount: parseFloat(formData.get('totalAmount') as string),
      installments: parseInt(formData.get('installments') as string) || 1,
      hasInvoice: formData.get('hasInvoice') === 'on',
      notes: formData.get('notes') || undefined,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🛒 Compras de Materiais</h1>
          <p className="text-sm text-gray-500 mt-1">
            Registre compras — elas atualizam automaticamente o Realizado do orçamento
          </p>
        </div>
        <Button onClick={() => setModalOpen(true)}>
          <Plus className="w-4 h-4" /> Nova Compra
        </Button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3">Data</th>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Ambiente</th>
              <th className="px-4 py-3">Tipo</th>
              <th className="px-4 py-3">Loja</th>
              <th className="px-4 py-3">Pagamento</th>
              <th className="px-4 py-3 text-right">Valor</th>
              <th className="px-4 py-3 text-right">Parcelas</th>
              <th className="px-4 py-3">NF</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {displayPurchases.map((p) => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-600">
                  {new Date(p.date).toLocaleDateString('pt-BR')}
                </td>
                <td className="px-4 py-2 font-medium text-gray-900">{p.item}</td>
                <td className="px-4 py-2 text-gray-600">{p.room.name}</td>
                <td className="px-4 py-2 text-gray-600">{p.workType.name}</td>
                <td className="px-4 py-2 text-gray-600">{p.store ?? '—'}</td>
                <td className="px-4 py-2 text-gray-600">{p.paymentMethod}</td>
                <td className="px-4 py-2 text-right font-medium">{formatCurrency(p.totalAmount)}</td>
                <td className="px-4 py-2 text-right text-gray-600">{p.installments}x</td>
                <td className="px-4 py-2">
                  {p.hasInvoice ? '✅' : '❌'}
                </td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => deleteMutation.mutate(p.id)}
                    className="text-red-500 hover:text-red-700 p-1"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-gray-50 font-semibold">
              <td colSpan={6} className="px-4 py-2 text-right">TOTAL</td>
              <td className="px-4 py-2 text-right">{formatCurrency(total)}</td>
              <td colSpan={3}></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Nova Compra de Material">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input id="date" name="date" label="Data" type="date" required />
            <Input id="item" name="item" label="Item" placeholder="Ex: Porcelanato 60x60" required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input id="roomId" name="roomId" label="ID Ambiente" placeholder="room-id" required />
            <Input id="workTypeId" name="workTypeId" label="ID Tipo de Obra" placeholder="work-type-id" required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input id="store" name="store" label="Loja" placeholder="Ex: Leroy Merlin" />
            <Select id="paymentMethod" name="paymentMethod" label="Forma de Pagamento" options={paymentMethods} required />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Input id="totalAmount" name="totalAmount" label="Valor Total (R$)" type="number" step="0.01" min="0.01" required />
            <Input id="installments" name="installments" label="Parcelas" type="number" min="1" defaultValue="1" />
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="hasInvoice" className="rounded" />
                Nota Fiscal
              </label>
            </div>
          </div>
          <Input id="notes" name="notes" label="Observações" placeholder="Ex: Entrega em 15 dias" />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button>
            <Button type="submit" disabled={createMutation.isPending}>
              <ShoppingCart className="w-4 h-4" /> Salvar Compra
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
