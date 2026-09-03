import { AlertCircle } from 'lucide-react';

/**
 * Estado da categorização automática em lote de um preview de importação
 * (extrato bancário / fatura de cartão). Vem do topo do payload de preview:
 * `bank-accounts/:id/import-statement?mode=preview` e
 * `credit-cards/:id/import-statement?mode=preview` (#582 PR-4/5).
 * Descreve o LOTE, não a linha.
 */
export type ImportClassificationStatus = 'ok' | 'unavailable' | 'error';

/**
 * Origem da categoria sugerida numa linha do preview (`categoriaFonte`):
 * `regra` = regra manual do tenant/global; `ia` = classificação por IA acima
 * do limiar; `regex` = heurística local de palavras-chave. `null` = sem
 * sugestão de origem (heurístico não casou nada).
 */
export type CategoriaFonte = 'regra' | 'ia' | 'regex';

/**
 * Copy neutra (sem "IA"/"Maria"): o import nunca bloqueia — os dois estados
 * degradados têm o mesmo peso visual (âmbar) e a mesma ação: revisar antes de
 * confirmar.
 */
const NOTICE_BY_STATUS: Record<'unavailable' | 'error', string> = {
  unavailable:
    'A categorização automática está indisponível agora. Revise as categorias sugeridas antes de confirmar.',
  error:
    'A categorização automática não foi concluída. Revise as categorias sugeridas antes de confirmar.',
};

const FONTE_LABEL: Record<CategoriaFonte, string> = {
  regra: 'Regra',
  ia: 'IA',
  regex: 'Sugestão automática',
};

/**
 * Banner âmbar exibido no preview quando a categorização automática do lote
 * não rodou (`unavailable`) ou não terminou (`error`). `ok`/ausente → nada.
 * Mesmo padrão visual do aviso "parece uma fatura" do extrato.
 */
export function ImportClassificationNotice({
  status,
}: {
  status?: ImportClassificationStatus | null;
}) {
  if (status !== 'unavailable' && status !== 'error') return null;
  return (
    <div className="rounded-xl bg-amber-50 border border-amber-300 text-amber-800 p-3 mb-3 text-sm flex gap-2">
      <AlertCircle className="w-5 h-5 flex-shrink-0" />
      <span>{NOTICE_BY_STATUS[status]}</span>
    </div>
  );
}

/**
 * Chip passivo (não clicável) com a origem da categoria sugerida na linha.
 * `null`/indefinido/valor desconhecido → nada renderizado.
 */
export function CategoriaFonteChip({ fonte }: { fonte?: CategoriaFonte | null }) {
  if (!fonte || !(fonte in FONTE_LABEL)) return null;
  return (
    <span className="mt-1 inline-flex w-fit max-w-full items-center rounded-full bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-500">
      {FONTE_LABEL[fonte]}
    </span>
  );
}
