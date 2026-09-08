import { formatCurrency, formatDateBR } from '@/lib/utils';

/**
 * Tier B do dedupe cross-origin (#659): o servidor casou a chave natural
 * (mesma data + valor + descrição) de uma linha do arquivo contra um
 * lançamento que já existe no projeto, importado por OUTRA origem. Não é
 * duplicata forte (Tier A) — pode ser coincidência — então o servidor NÃO
 * importa por padrão e só cria a linha se o commit mandar `action:'import'`.
 *
 * Esta é a superfície de review: o payload de preview já traz `possibleDuplicate`
 * por linha (`bank-accounts` / `credit-cards` / `receipts?origin=none`); a UI
 * mostra o lançamento existente e um opt-in explícito por linha.
 */
export interface PossibleDuplicateInfo {
  externalId?: string;
  existingId: string;
  existingOrigin: string;
  existingDate: string;
  existingAmountCents: number;
  /** Motivo legível por máquina (ex.: `same_natural_key_different_source`). */
  reason: string;
}

const REASON_COPY: Record<string, string> = {
  same_natural_key_different_source:
    'Mesma data e valor de um lançamento já registrado por outra origem.',
};

function reasonText(reason: string): string {
  return (
    REASON_COPY[reason] ??
    'Parece com um lançamento que já existe no projeto.'
  );
}

interface Props {
  info: PossibleDuplicateInfo;
  /** true quando o usuário marcou "Importar mesmo assim" para esta linha. */
  optedIn: boolean;
  onToggle: (next: boolean) => void;
}

export function PossibleDuplicateNotice({ info, optedIn, onToggle }: Props) {
  const existingDate = formatDateBR(info.existingDate);
  return (
    <div className="mt-2 rounded-r-lg border-l-2 border-orange-400 bg-orange-50 py-1.5 pl-3 pr-2">
      <p className="text-xs font-medium text-orange-800">
        ⚠ Possível duplicata
      </p>
      <p className="text-xs text-orange-700">
        {reasonText(info.reason)} Já existe um lançamento de{' '}
        <span className="whitespace-nowrap font-medium">
          {formatCurrency(Math.abs(info.existingAmountCents) / 100)}
        </span>
        {existingDate !== '-' ? <> em {existingDate}</> : null}.
      </p>
      <label className="mt-1 inline-flex min-h-11 items-center gap-2 text-xs font-medium text-orange-900">
        <input
          type="checkbox"
          checked={optedIn}
          onChange={(event) => onToggle(event.currentTarget.checked)}
          className="h-4 w-4 shrink-0 accent-orange-600"
        />
        Importar mesmo assim
      </label>
      {!optedIn && (
        <span className="sr-only">
          Esta linha não será importada enquanto a caixa não for marcada.
        </span>
      )}
    </div>
  );
}
