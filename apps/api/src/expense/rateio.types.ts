/**
 * Lente de acesso do requisitante (subconjunto de `request.user` — jwt.strategy).
 * Obrigatório no tipo (não opcional): qualquer call-site que esqueça a lente
 * quebra em `tsc --noEmit` no pre-commit, não em produção (fail-closed).
 */
export interface RateioRequester {
  role?: string;
  allowedProjects?: string[];
  allowedProjectTypes?: string[];
  allowedModules?: string[];
}

/** Fail-closed runtime guard for untyped/JavaScript callers. */
export function assertRateioRequester(
  requester: RateioRequester | null | undefined,
  error: Error = new ForbiddenException(REQUESTER_REQUIRED_MESSAGE),
): asserts requester is RateioRequester {
  if (!requester) {
    throw error;
  }
}

/** Uma linha do rateio: uma alocação da compra-fonte para uma planejada de outro projeto. */
export interface RateioDetalheItem {
  /** Expense alvo (PK da alocação — @@unique, serve de chave de lista e de ordenação). */
  targetExpenseId: string;
  /** Título CRU do alvo. O fallback para `fornecedor` é apresentação (web). */
  titulo: string | null;
  fornecedor: string | null;
  /** Projeto DONO do alvo (referência estável de identidade, nunca a relação deletável). */
  projectId: string;
  projectName: string;
  projectType: string;
  /** Centavos alocados a este alvo (RateioAllocation.allocation). */
  allocationCents: number;
  /**
   * Valor total ORIGINAL do alvo antes do rateio sobrescrever seu cronograma
   * (snapshot RateioAllocation.plannedValorTotal). `null` em rateios legados,
   * criados antes do snapshot existir — NUNCA normalizar para 0.
   */
  plannedValorTotalCents: number | null;
  /** Status ATUAL do alvo (PLANEJADO | PAGO) — não o snapshot. */
  status: string;
}

export interface RateioDetalhe {
  /**
   * Fonte canônica do rateio — MAS, quando a resposta é redigida (source-only),
   * é o id da própria despesa pedida. Devolver a fonte real junto de
   * `rateado: false` provaria que existe aresta de rateio e, portanto, que há
   * participante que o requisitante não pode ver.
   */
  sourceExpenseId: string;
  /**
   * B1b (#448) — TUDO-OU-NADA: `true` só quando TODOS os participantes estão
   * autorizados para este requisitante E a soma dos vivos fecha exatamente o
   * total da fonte. Em qualquer outro caso a resposta inteira é a de uma compra
   * nunca rateada.
   */
  rateado: boolean;
  /** valorTotal em centavos da despesa que ancora a resposta. */
  totalSourceCents: number;
  /**
   * Σ allocationCents dos itens devolvidos — logo, `totalSourceCents` quando há
   * detalhamento e `0` quando a resposta é source-only.
   *
   * Por que não existe versão "parcial" deste número: `conciliacao.service.ts`
   * recusa a escrita se `Σ alocações !== valorTotal`, então uma lista filtrada
   * publicada ao lado do total entregaria a soma oculta por subtração
   * (`totalSourceCents - Σ itens`), em centavos exatos. O vazamento apenas
   * trocaria de nome — de campo nomeado para campo calculado.
   */
  rateadoCents: number;
  /** totalSourceCents - rateadoCents. Vale o total inteiro na resposta redigida. */
  sobraCents: number;
  /**
   * Alocações cujo alvo foi soft-deletado. Estruturalmente SEMPRE 0 sob o
   * contrato B1b: um alvo removido faz a soma dos vivos não fechar, o que já
   * colapsa a resposta para source-only. Mantido para estabilidade de forma do
   * payload (o web lê o campo) e para que "removido" não seja um estado
   * distinguível de "não rateado".
   */
  removedTargetsCount: number;
  /** Ordem determinística: createdAt asc, targetExpenseId asc (desempate total). */
  items: RateioDetalheItem[];
}
import { ForbiddenException } from '@nestjs/common';

const REQUESTER_REQUIRED_MESSAGE = 'Requisitante obrigatório';
