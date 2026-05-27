import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { CATEGORIA_MAO_DE_OBRA_OPTIONS, FORMA_PAGAMENTO_OPTIONS } from '@/lib/expense-options';
import { formatCurrency } from '@/lib/utils';
import { VinculosFields } from './VinculosFields';
import type { Expense } from '@/types';

interface ExpenseOption {
  value: string;
  label: string;
}

interface RoomOption {
  value: string;
  label: string;
}

export interface ExpenseFormVinculos {
  creditCardId: string;
  bankAccountId: string;
  linkedExpenseId: string;
}

interface ExpenseFormModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  editing: Expense | null;
  formStatus: 'PLANEJADO' | 'PAGO';
  tipoDespesa: string;
  setTipoDespesa: (value: string) => void;
  formaPagamento: string;
  setFormaPagamento: (value: string) => void;
  valor: string;
  setValor: (value: string) => void;
  quantidade: string;
  setQuantidade: (value: string) => void;
  valorTotal: number;
  formVinculos: ExpenseFormVinculos;
  setFormVinculos: (v: ExpenseFormVinculos) => void;
  projectId: string;
  showRooms: boolean;
  tipoDespesaOptions: ExpenseOption[];
  roomOptions: RoomOption[];
  isPending: boolean;
}

export function ExpenseFormModal({
  open,
  onClose,
  onSubmit,
  editing,
  formStatus,
  tipoDespesa,
  setTipoDespesa,
  formaPagamento,
  setFormaPagamento,
  valor,
  setValor,
  quantidade,
  setQuantidade,
  valorTotal,
  formVinculos,
  setFormVinculos,
  projectId,
  showRooms,
  tipoDespesaOptions,
  roomOptions,
  isPending,
}: ExpenseFormModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Editar Despesa' : formStatus === 'PLANEJADO' ? 'Planejar Despesa' : 'Nova Despesa (Paga)'}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Select
          label="Tipo da Despesa"
          name="tipoDespesa"
          options={tipoDespesaOptions}
          required
          value={tipoDespesa}
          onChange={(e) => setTipoDespesa(e.target.value)}
        />

        {tipoDespesa === 'MAO_DE_OBRA' && (
          <Select
            label="Categoria Mão de Obra"
            name="categoriaMaoDeObra"
            options={CATEGORIA_MAO_DE_OBRA_OPTIONS}
            defaultValue={editing?.categoriaMaoDeObra ?? ''}
          />
        )}

        {showRooms && (
          <Select
            label="Ambiente"
            name="roomId"
            options={roomOptions}
            defaultValue={editing?.roomId ?? ''}
          />
        )}

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Valor (R$)"
            name="valor"
            type="number"
            step="0.01"
            min="0"
            required
            value={valor}
            onChange={(e) => setValor(e.target.value)}
          />
          <Input
            label="Quantidade"
            name="quantidade"
            type="number"
            min="1"
            required
            value={quantidade}
            onChange={(e) => setQuantidade(e.target.value)}
          />
        </div>

        <div className="text-sm text-gray-600">
          Valor Total: <span className="font-semibold">{formatCurrency(valorTotal)}</span>
        </div>

        <Input label="Título da Despesa" name="titulo" defaultValue={editing?.titulo ?? ''} />
        <Input label="Fornecedor" name="fornecedor" defaultValue={editing?.fornecedor ?? ''} />
        <Input label="Link" name="link" type="text" defaultValue={editing?.link ?? ''} />
        <Input
          label="URL da Imagem (opcional)"
          name="imageUrl"
          type="text"
          placeholder="Cole a URL direta da imagem do produto"
          defaultValue={editing?.imageUrl ?? ''}
        />

        <Select
          label="Forma de Pagamento"
          name="formaPagamento"
          options={FORMA_PAGAMENTO_OPTIONS}
          required
          value={formaPagamento}
          onChange={(e) => setFormaPagamento(e.target.value)}
        />

        {formaPagamento === 'A_VISTA' && (
          <Input
            label="Data do Pagamento"
            name="dataPagamento"
            type="date"
            defaultValue={editing?.dataPagamento?.slice(0, 10) ?? ''}
          />
        )}

        {(formaPagamento === 'PARCELADO' || formaPagamento === 'QUINZENAL') && (
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Qtd Parcelas"
              name="quantidadeParcela"
              type="number"
              min="1"
              defaultValue={editing?.quantidadeParcela ?? ''}
            />
            <Input
              label="Data de Início"
              name="dataInicioParcela"
              type="date"
              defaultValue={editing?.dataInicioParcela?.slice(0, 10) ?? ''}
            />
          </div>
        )}

        <VinculosFields
          projectId={projectId}
          value={formVinculos}
          onChange={setFormVinculos}
          initialCardLast4={editing?.cardLast4 ?? null}
          initialBankLast4={editing?.bankLast4 ?? null}
          initialLinkedExpenseId={editing?.linkedExpenseId ?? null}
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={isPending}>
            {editing ? 'Salvar' : 'Criar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
