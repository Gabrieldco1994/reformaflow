import { ProjectType } from '@reformaflow/domain';
import { isIncludedInSaidaTotal } from '../_lib';
import type { AccountViewSaida } from '../_types';

/**
 * U6b build 1 (#456) — builder/re-key da lente `by-type` da Visão Conta.
 * Contrato: `docs/financeiro-projetos-por-tipo.md` §7.5 (decisão do PO).
 *
 * Agrupa `saidas` + `comprasCartao` (payload existente de account-view) por
 * `projetoOrigem.type` estrito — nunca por rótulo/nome. `entradas` fica de
 * fora por design (não é parâmetro desta função).
 *
 * Invariante travado por teste: Σ(groups[i].total) === soma dos `saidas` para
 * os quais `isIncludedInSaidaTotal` é verdadeiro (a mesma base do "Saiu" da
 * Visão Conta, `page.tsx:110`). A soma NUNCA usa `comprasCartao` como fonte
 * adicional de valor — comprasCartao só desloca (nunca soma) dinheiro já
 * contado na fatura (`saidas[].isInvoice`) do bucket PESSOAL para o tipo real
 * do projeto que originou a compra, um item de cada vez e sem alterar o total.
 *
 * Carteira (§2.1/§7.4, invariante O8): `saidas` sem cartão/conta que
 * pertencem ao próprio PESSOAL chegam com `projetoOrigem: null` (backend,
 * `localCarteiraThisMonth`) e caem no bucket self por essa mesma regra —
 * "Carteira permanece PESSOAL". Já uma despesa de OUTRO projeto paga pela
 * Carteira do PESSOAL (`carteiraPaidThisMonth`) chega com `projetoOrigem` já
 * preenchido com o tipo real — o MESMO campo que `porProjetoFiltered`/
 * `PorProjetoCategoriaView` já usam hoje para agrupar por projeto; não há
 * disclosure nova aqui. O invariante O8 ("Carteira nunca divulgada como
 * origem cross-project") é sobre `classifySource`/`paid-origins.builder.ts`,
 * mecanismo de outra superfície (fora de escopo desta lente).
 */

/** Tipos que podem RECEBER dinheiro deslocado de uma fatura de cartão. PLANTAS
 * nunca é alvo — não tem capacidade `expenses` em nenhuma das três fontes
 * (`project-features.ts`), então nunca é origem legítima de uma compra. */
const NETTABLE_TYPES = new Set<string>([
  ProjectType.REFORMA,
  ProjectType.COMPRA,
  ProjectType.CASA,
  ProjectType.CARRO,
]);

export interface ByTypeGroup {
  type: string;
  /** Centavos. */
  total: number;
  count: number;
  /** `false` somente para PLANTAS — "sem financeiro por design" (§1.2). */
  hasFinance: boolean;
}

interface Bucket {
  total: number;
  count: number;
}

function bump(map: Map<string, Bucket>, type: string, valor: number) {
  const cur = map.get(type) ?? { total: 0, count: 0 };
  cur.total += valor;
  cur.count += 1;
  map.set(type, cur);
}

/** Tipo do bucket para uma saída direta (não-cartão): usa `projetoOrigem.type`
 * quando é um tipo conhecido e "nettable"; qualquer outro caso (ausente,
 * PESSOAL, ou desconhecido) cai em PESSOAL — fail-closed, nunca inferido pelo
 * nome do projeto. */
function bucketTypeForSaida(
  projetoOrigem: { type: string } | null | undefined,
  selfProjectType: string,
): string {
  if (projetoOrigem && NETTABLE_TYPES.has(projetoOrigem.type)) return projetoOrigem.type;
  return selfProjectType;
}

export function buildByTypeGroups({
  saidas,
  comprasCartao,
  selfProjectType,
}: {
  saidas: AccountViewSaida[];
  comprasCartao: AccountViewSaida[];
  selfProjectType: string;
}): ByTypeGroup[] {
  // Fail-closed: a lente `by-type` só existe na Visão Conta, que é PESSOAL-only
  // (`page.tsx:132-138`). Tipo ausente/diferente nunca produz grupo nenhum —
  // não há inferência por nome.
  if (selfProjectType !== ProjectType.PESSOAL) return [];

  const totals = new Map<string, Bucket>();

  // 1) Baseline: cada saída elegível (isIncludedInSaidaTotal) conta 1x. As
  //    linhas de fatura (`isInvoice`) contam o valor cheio em PESSOAL aqui —
  //    é o mesmo valor que o "Saiu" da tela já soma.
  for (const s of saidas) {
    if (!isIncludedInSaidaTotal(s)) continue;
    bump(totals, bucketTypeForSaida(s.projetoOrigem, selfProjectType), s.valor);
  }

  // 2) Netting: uma compra de cartão atribuível a outro tipo desloca o valor
  //    já contado na fatura (passo 1) do bucket PESSOAL para o bucket real —
  //    soma líquida zero, então o invariante Σ = total nunca muda aqui.
  for (const c of comprasCartao) {
    if (!isIncludedInSaidaTotal(c)) continue;
    const proj = c.projetoOrigem;
    if (!proj) continue; // já é PESSOAL — nada a deslocar
    if (!NETTABLE_TYPES.has(proj.type)) continue; // PESSOAL/PLANTAS/desconhecido: fail-closed, fica onde está
    const pessoal = totals.get(ProjectType.PESSOAL);
    if (pessoal) pessoal.total -= c.valor;
    bump(totals, proj.type, c.valor);
  }

  const result: ByTypeGroup[] = [];

  const pessoal = totals.get(ProjectType.PESSOAL) ?? { total: 0, count: 0 };
  result.push({ type: ProjectType.PESSOAL, total: pessoal.total, count: pessoal.count, hasFinance: true });

  for (const type of [ProjectType.REFORMA, ProjectType.COMPRA, ProjectType.CASA, ProjectType.CARRO]) {
    const bucket = totals.get(type);
    if (bucket && bucket.count > 0) {
      result.push({ type, total: bucket.total, count: bucket.count, hasFinance: true });
    }
  }

  // PLANTAS: "sem financeiro por design" (§1.2) — sempre aparece, nunca com
  // movimento fabricado (PLANTAS não pode ter chegado a `totals` porque não
  // tem capacidade `expenses` em nenhuma fonte de origem/gate).
  result.push({ type: ProjectType.PLANTAS, total: 0, count: 0, hasFinance: false });

  return result;
}
