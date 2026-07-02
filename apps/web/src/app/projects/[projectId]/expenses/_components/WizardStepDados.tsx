'use client';
import { DadosDespesaFields } from './DadosDespesaFields';
import type { WizardDraft } from '../_hooks/useNovaDespesaWizard';

interface Option {
  value: string;
  label: string;
}

interface Props {
  draft: WizardDraft;
  patch: (patch: Partial<WizardDraft>) => void;
  tipoOptions: Option[];
  roomOptions: Option[];
  showRooms: boolean;
}

/**
 * Passo 1 (DADOS) do wizard "+Nova despesa": tipo, categoria (mão de obra),
 * ambiente, valor/quantidade e título. 100% controlado pelo `draft` do reducer —
 * reusa `DadosDespesaFields` no modo controlado (props opcionais aditivas).
 */
export function WizardStepDados({ draft, patch, tipoOptions, roomOptions, showRooms }: Props) {
  const valorTotal = (Number(draft.valor) || 0) * (Number(draft.quantidade) || 0);
  return (
    <DadosDespesaFields
      tipoDespesa={draft.tipoDespesa}
      setTipoDespesa={(v) => patch({ tipoDespesa: v })}
      tipoDespesaOptions={tipoOptions}
      categoriaMaoDeObra={draft.categoriaMaoDeObra}
      setCategoriaMaoDeObra={(v) => patch({ categoriaMaoDeObra: v })}
      showRooms={showRooms}
      roomOptions={roomOptions}
      editing={null}
      valor={draft.valor}
      setValor={(v) => patch({ valor: v })}
      quantidade={draft.quantidade}
      setQuantidade={(v) => patch({ quantidade: v })}
      valorTotal={valorTotal}
      titulo={draft.titulo}
      setTitulo={(v) => patch({ titulo: v })}
      roomIdValue={draft.roomId}
      onRoomIdChange={(v) => patch({ roomId: v })}
    />
  );
}
