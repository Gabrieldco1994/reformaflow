'use client';
import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { tipoLabel } from '@/lib/expense-options';
import { VinculosFields } from './VinculosFields';
import { DadosDespesaFields } from './DadosDespesaFields';
import { FormaPagamentoFields } from './FormaPagamentoFields';
import type { LinkedExpenseDraft } from './CreateLinkedExpenseModal';
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
  /** Parcela 0-based do alvo escolhida no vínculo cross-project (null = nenhuma). */
  linkedParcelaIndex?: number | null;
}

interface ExpenseFormModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  editing: Expense | null;
  formStatus: 'PLANEJADO' | 'PAGO';
  /** Habilita "Despesa fixa (recorrente)" — apenas PESSOAL. */
  allowRecorrente?: boolean;
  tipoDespesa: string;
  setTipoDespesa: (value: string) => void;
  formaPagamento: string;
  setFormaPagamento: (value: string) => void;
  valor: string;
  setValor: (value: string) => void;
  quantidade: string;
  setQuantidade: (value: string) => void;
  valorTotal: number;
  titulo: string;
  setTitulo: (value: string) => void;
  fornecedor: string;
  setFornecedor: (value: string) => void;
  categoriaMaoDeObra: string;
  setCategoriaMaoDeObra: (value: string) => void;
  dataPagamento: string;
  setDataPagamento: (value: string) => void;
  dataInicioParcela: string;
  setDataInicioParcela: (value: string) => void;
  formVinculos: ExpenseFormVinculos;
  setFormVinculos: (v: ExpenseFormVinculos) => void;
  onLinkSelected?: (exp: {
    tipoDespesa?: string | null;
    categoriaMaoDeObra?: string | null;
    titulo?: string | null;
    fornecedor?: string | null;
    formaPagamento?: string | null;
    dataPagamento?: string | null;
    dataInicioParcela?: string | null;
  }) => void;
  projectId: string;
  showRooms: boolean;
  tipoDespesaOptions: ExpenseOption[];
  roomOptions: RoomOption[];
  isPending: boolean;
  /** Snapshot dos campos atuais — usado para pré-preencher o modal "criar despesa em outro projeto". */
  linkedExpenseDraft?: LinkedExpenseDraft;
  /** Abre o modal "Ratear compra" para a despesa em edição (apenas fonte PESSOAL). */
  onRatear?: () => void;
}

export function ExpenseFormModal({
  open,
  onClose,
  onSubmit,
  editing,
  formStatus,
  allowRecorrente,
  tipoDespesa,
  setTipoDespesa,
  formaPagamento,
  setFormaPagamento,
  valor,
  setValor,
  quantidade,
  setQuantidade,
  valorTotal,
  titulo,
  setTitulo,
  fornecedor,
  setFornecedor,
  categoriaMaoDeObra,
  setCategoriaMaoDeObra,
  dataPagamento,
  setDataPagamento,
  dataInicioParcela,
  setDataInicioParcela,
  formVinculos,
  setFormVinculos,
  onLinkSelected,
  projectId,
  showRooms,
  tipoDespesaOptions,
  roomOptions,
  isPending,
  linkedExpenseDraft,
  onRatear,
}: ExpenseFormModalProps) {
  const [showAdvanced, setShowAdvanced] = useState(
    Boolean(editing?.cardLast4 || editing?.bankLast4 || editing?.linkedExpenseId || editing?.link || editing?.imageUrl),
  );
  const [recorrente, setRecorrente] = useState(Boolean(editing?.recorrente));
  useEffect(() => {
    if (open) setRecorrente(Boolean(editing?.recorrente));
  }, [open, editing]);
  // Inclui o tipo ativo nas opções mesmo se ele não pertencer ao conjunto padrão
  // do projeto (ex.: tipo herdado de uma despesa vinculada de outro tipo de projeto).
  const effectiveTipoOptions =
    tipoDespesa && !tipoDespesaOptions.some((o) => o.value === tipoDespesa)
      ? [...tipoDespesaOptions, { value: tipoDespesa, label: tipoLabel(tipoDespesa) }]
      : tipoDespesaOptions;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Editar Despesa' : formStatus === 'PLANEJADO' ? 'Planejar Despesa' : 'Nova Despesa (Paga)'}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <DadosDespesaFields
          tipoDespesa={tipoDespesa}
          setTipoDespesa={setTipoDespesa}
          tipoDespesaOptions={effectiveTipoOptions}
          categoriaMaoDeObra={categoriaMaoDeObra}
          setCategoriaMaoDeObra={setCategoriaMaoDeObra}
          showRooms={showRooms}
          roomOptions={roomOptions}
          editing={editing}
          valor={valor}
          setValor={setValor}
          quantidade={quantidade}
          setQuantidade={setQuantidade}
          valorTotal={valorTotal}
          titulo={titulo}
          setTitulo={setTitulo}
        />

        <FormaPagamentoFields
          formaPagamento={formaPagamento}
          setFormaPagamento={setFormaPagamento}
          dataPagamento={dataPagamento}
          setDataPagamento={setDataPagamento}
          dataInicioParcela={dataInicioParcela}
          setDataInicioParcela={setDataInicioParcela}
          allowRecorrente={allowRecorrente}
          editing={editing}
          recorrente={recorrente}
          setRecorrente={setRecorrente}
        />

        {/* Mais opções — campos avançados recolhidos para reduzir fricção */}
        <div className="rounded-xl border border-darc-linen">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium text-darc-velvet/70 hover:bg-orange-50/40"
          >
            {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Mais opções
            <span className="text-[11px] font-normal text-darc-velvet/40">fornecedor · link · imagem · cartão/conta</span>
          </button>
          <div className={`space-y-4 px-3 pb-3 ${showAdvanced ? '' : 'hidden'}`}>
            <Input label="Fornecedor" name="fornecedor" value={fornecedor} onChange={(e) => setFornecedor(e.target.value)} />
            <Input label="Link" name="link" type="text" defaultValue={editing?.link ?? ''} />
            <Input
              label="URL da Imagem (opcional)"
              name="imageUrl"
              type="text"
              placeholder="Cole a URL direta da imagem do produto"
              defaultValue={editing?.imageUrl ?? ''}
            />
            <VinculosFields
              projectId={projectId}
              value={formVinculos}
              onChange={setFormVinculos}
              onLinkSelected={onLinkSelected}
              initialCardLast4={editing?.cardLast4 ?? null}
              initialBankLast4={editing?.bankLast4 ?? null}
              initialLinkedExpenseId={editing?.linkedExpenseId ?? null}
              baseDraft={linkedExpenseDraft}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          {editing && onRatear && (
            <Button type="button" variant="ghost" onClick={onRatear} className="mr-auto">
              Ratear compra
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={isPending}>
            {editing ? 'Salvar' : 'Criar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
