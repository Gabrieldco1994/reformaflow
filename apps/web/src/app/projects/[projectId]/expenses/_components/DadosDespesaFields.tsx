'use client';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CATEGORIA_MAO_DE_OBRA_OPTIONS } from '@/lib/expense-options';
import { formatCurrency } from '@/lib/utils';
import type { Expense } from '@/types';

interface ExpenseOption {
  value: string;
  label: string;
}

interface RoomOption {
  value: string;
  label: string;
}

export interface DadosDespesaFieldsProps {
  tipoDespesa: string;
  setTipoDespesa: (value: string) => void;
  /** Opções de tipo já resolvidas (inclui o tipo ativo fora do conjunto padrão). */
  tipoDespesaOptions: ExpenseOption[];
  categoriaMaoDeObra: string;
  setCategoriaMaoDeObra: (value: string) => void;
  showRooms: boolean;
  roomOptions: RoomOption[];
  editing: Expense | null;
  valor: string;
  setValor: (value: string) => void;
  quantidade: string;
  setQuantidade: (value: string) => void;
  valorTotal: number;
  titulo: string;
  setTitulo: (value: string) => void;
  /**
   * Ambiente controlado (wizard). Quando fornecido, o Select de ambiente é
   * renderizado controlado; quando ausente, mantém `defaultValue` + FormData
   * (comportamento original do ExpenseFormModal). Aditivo e retrocompatível.
   */
  roomIdValue?: string;
  onRoomIdChange?: (value: string) => void;
  /** Mostra badge "sugerido por IA" junto ao campo Tipo (Feature de categorização automática). */
  tipoSuggestedByAi?: boolean;
}

/**
 * Bloco DADOS do formulário de despesa — extraído do ExpenseFormModal.
 * Renderiza tipo, categoria (mão de obra), ambiente, valor/quantidade,
 * valor total e título. Nomes de inputs preservados (lidos via FormData).
 */
export function DadosDespesaFields({
  tipoDespesa,
  setTipoDespesa,
  tipoDespesaOptions,
  categoriaMaoDeObra,
  setCategoriaMaoDeObra,
  showRooms,
  roomOptions,
  editing,
  valor,
  setValor,
  quantidade,
  setQuantidade,
  valorTotal,
  titulo,
  setTitulo,
  roomIdValue,
  onRoomIdChange,
  tipoSuggestedByAi,
}: DadosDespesaFieldsProps) {
  const roomControlled = roomIdValue !== undefined && onRoomIdChange !== undefined;
  return (
    <>
      <div className="relative">
        <Select
          label="Tipo da Despesa"
          name="tipoDespesa"
          options={tipoDespesaOptions}
          required
          value={tipoDespesa}
          onChange={(e) => setTipoDespesa(e.target.value)}
        />
        {tipoSuggestedByAi && (
          <span className="absolute right-0 top-0 rounded-full bg-darc-maroon/10 px-2 py-0.5 text-[11px] font-medium text-darc-maroon">
            sugerido por IA
          </span>
        )}
      </div>

      {tipoDespesa === 'MAO_DE_OBRA' && (
        <Select
          label="Categoria Mão de Obra"
          name="categoriaMaoDeObra"
          options={CATEGORIA_MAO_DE_OBRA_OPTIONS}
          value={categoriaMaoDeObra}
          onChange={(e) => setCategoriaMaoDeObra(e.target.value)}
        />
      )}

      {showRooms &&
        (roomControlled ? (
          <Select
            label="Ambiente"
            name="roomId"
            options={roomOptions}
            value={roomIdValue}
            onChange={(e) => onRoomIdChange?.(e.target.value)}
          />
        ) : (
          <Select
            label="Ambiente"
            name="roomId"
            options={roomOptions}
            defaultValue={editing?.roomId ?? ''}
          />
        ))}

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

      <Input label="Título da Despesa" name="titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
    </>
  );
}
