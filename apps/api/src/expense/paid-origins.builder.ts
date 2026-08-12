import { projectTypeHasModule } from '@reformaflow/domain';
import { isFullAccessRole } from '../common/access-rules';
import {
  BuildPaidOriginsInput,
  ExpensePaidOrigin,
  PaidOriginAccountRow,
  PaidOriginCardRow,
  PaidOriginKind,
  PaidOriginRef,
  PaidOriginSettlementRow,
  PaidOriginSourceRow,
  PaidOriginsViewer,
} from './paid-origins.types';

/**
 * Pure derivation of "who paid this" per target expense. Zero Prisma, zero
 * I/O — every input is already resolved (active-source re-read done by the
 * caller, O2). See docs/quitacao-parcela-cross-project.md §10 for the
 * invariants (O1-O12) this function enforces.
 */
export function buildPaidOrigins(input: BuildPaidOriginsInput): ExpensePaidOrigin[] {
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));

  const settledTargets = new Set(input.settlements.map((row) => row.targetExpenseId));
  const rateioTargets = new Set(
    input.rateios
      .map((row) => row.targetExpenseId)
      .filter((targetExpenseId) => !settledTargets.has(targetExpenseId)),
  );

  const items: ExpensePaidOrigin[] = [];

  items.push(...buildSettlementItems(input, sourceById));
  items.push(...buildRateioItems(input, sourceById, settledTargets));
  items.push(...buildLinkItems(input, sourceById, settledTargets, rateioTargets));

  return items.sort((a, b) => a.expenseId.localeCompare(b.expenseId));
}

function buildSettlementItems(
  input: BuildPaidOriginsInput,
  sourceById: Map<string, PaidOriginSourceRow>,
): ExpensePaidOrigin[] {
  const rowsByTarget = new Map<string, PaidOriginSettlementRow[]>();
  for (const row of input.settlements) {
    const list = rowsByTarget.get(row.targetExpenseId) ?? [];
    list.push(row);
    rowsByTarget.set(row.targetExpenseId, list);
  }

  const items: ExpensePaidOrigin[] = [];
  for (const [targetExpenseId, rows] of rowsByTarget) {
    const sorted = [...rows].sort((a, b) => a.parcelaIndex - b.parcelaIndex);
    const parcelas: ExpensePaidOrigin['parcelas'] = [];
    for (const row of sorted) {
      const ref = resolveVisibleRef(row.sourceExpenseId, sourceById, input);
      if (!ref) continue; // O2 (fonte inativa) / O8 (carteira) / O10 (redação)
      parcelas.push({ parcelaIndex: row.parcelaIndex, origin: ref });
    }
    if (parcelas.length === 0) continue; // O7: nenhum candidato sobrevivente → alvo some

    const origins = dedupOrigins(parcelas.map((p) => p.origin));
    items.push({
      expenseId: targetExpenseId,
      via: 'settlement',
      parcelas,
      origins,
      multiple: origins.length > 1,
    });
  }
  return items;
}

function buildRateioItems(
  input: BuildPaidOriginsInput,
  sourceById: Map<string, PaidOriginSourceRow>,
  settledTargets: Set<string>,
): ExpensePaidOrigin[] {
  const items: ExpensePaidOrigin[] = [];
  for (const row of input.rateios) {
    if (settledTargets.has(row.targetExpenseId)) continue; // O3: settlement > rateio
    const ref = resolveVisibleRef(row.sourceExpenseId, sourceById, input);
    if (!ref) continue;
    items.push({
      expenseId: row.targetExpenseId,
      via: 'rateio',
      parcelas: [],
      origins: [ref],
      multiple: false,
    });
  }
  return items;
}

function buildLinkItems(
  input: BuildPaidOriginsInput,
  sourceById: Map<string, PaidOriginSourceRow>,
  settledTargets: Set<string>,
  rateioTargets: Set<string>,
): ExpensePaidOrigin[] {
  const sourceIdsByTarget = new Map<string, Set<string>>();
  for (const row of input.links) {
    if (settledTargets.has(row.targetExpenseId) || rateioTargets.has(row.targetExpenseId)) continue; // O3
    const set = sourceIdsByTarget.get(row.targetExpenseId) ?? new Set<string>();
    set.add(row.sourceExpenseId);
    sourceIdsByTarget.set(row.targetExpenseId, set);
  }

  const items: ExpensePaidOrigin[] = [];
  for (const [targetExpenseId, sourceIds] of sourceIdsByTarget) {
    if (sourceIds.size !== 1) continue; // fonte reversa ambígua → OMITIDO por completo
    const [sourceExpenseId] = sourceIds;
    const ref = resolveVisibleRef(sourceExpenseId, sourceById, input);
    if (!ref) continue;
    items.push({
      expenseId: targetExpenseId,
      via: 'link',
      parcelas: [],
      origins: [ref],
      multiple: false,
    });
  }
  return items;
}

/** O2 + O8 + O10 in one gate: null means "this candidate contributes nothing". */
function resolveVisibleRef(
  sourceExpenseId: string,
  sourceById: Map<string, PaidOriginSourceRow>,
  input: BuildPaidOriginsInput,
): PaidOriginRef | null {
  const source = sourceById.get(sourceExpenseId);
  if (!source) return null; // O2: fonte não re-lida ativa (inexistente/soft-deletada)

  const classified = classifySource(source);
  if (!classified) return null; // O8: carteira não emite origem

  if (!canSeeOrigin(source.projectId, source.projectType, classified.kind, input.viewer)) {
    return null; // O10: redação por omissão
  }

  return buildRef(source, classified.kind, classified.last4, input.cards, input.accounts);
}

function classifySource(
  source: PaidOriginSourceRow,
): { kind: PaidOriginKind; last4: string } | null {
  if (source.cardLast4) return { kind: 'card', last4: source.cardLast4 };
  if (source.bankLast4) return { kind: 'bank', last4: source.bankLast4 };
  return null; // carteira: sem cartão e sem conta
}

function canSeeOrigin(
  sourceProjectId: string,
  sourceProjectType: string,
  kind: PaidOriginKind,
  viewer: PaidOriginsViewer,
): boolean {
  if (isFullAccessRole(viewer.role)) return true;
  if (viewer.projectScope !== null && !viewer.projectScope.includes(sourceProjectId)) return false;
  const slug = kind === 'card' ? 'creditCards' : 'bankAccounts';
  if (!viewer.allowedModules.includes(slug)) return false;
  if (!projectTypeHasModule(sourceProjectType, slug)) return false;
  return true;
}

function buildRef(
  source: PaidOriginSourceRow,
  kind: PaidOriginKind,
  last4: string,
  cards: PaidOriginCardRow[],
  accounts: PaidOriginAccountRow[],
): PaidOriginRef {
  const identity =
    kind === 'card'
      ? resolveCardIdentity(source.projectId, last4, cards)
      : resolveAccountIdentity(source, accounts);
  return {
    kind,
    last4,
    nickname: identity.nickname,
    institution: identity.institution,
    sourceProjectId: source.projectId,
    sourceProjectName: source.projectName,
  };
}

interface ResolvedIdentity {
  nickname: string | null;
  institution: string | null;
}

/** CARD-RESOLVE: mesmo projeto da fonte tem prioridade; empate por (createdAt asc, id asc). */
function resolveCardIdentity(
  sourceProjectId: string,
  last4: string,
  cards: PaidOriginCardRow[],
): ResolvedIdentity {
  const candidates = cards.filter((card) => card.last4 === last4);
  const winner = pickPreferred(candidates, sourceProjectId);
  if (!winner) return { nickname: null, institution: null };
  return { nickname: winner.nickname, institution: winner.brand };
}

/** BANK-RESOLVE: FK accountId exata tem prioridade; senão cai no last4 (legado). */
function resolveAccountIdentity(
  source: PaidOriginSourceRow,
  accounts: PaidOriginAccountRow[],
): ResolvedIdentity {
  if (source.accountId) {
    const exact = accounts.find((account) => account.id === source.accountId);
    if (exact) return { nickname: exact.nickname, institution: exact.institution };
  }
  if (!source.bankLast4) return { nickname: null, institution: null };
  const candidates = accounts.filter((account) => account.last4 === source.bankLast4);
  const winner = pickPreferred(candidates, source.projectId);
  if (!winner) return { nickname: null, institution: null };
  return { nickname: winner.nickname, institution: winner.institution };
}

function pickPreferred<T extends { projectId: string; createdAt: Date; id: string }>(
  candidates: T[],
  sourceProjectId: string,
): T | null {
  if (candidates.length === 0) return null;
  const preferred = candidates.filter((c) => c.projectId === sourceProjectId);
  const pool = preferred.length > 0 ? preferred : candidates;
  const sorted = [...pool].sort((a, b) => {
    const byDate = a.createdAt.getTime() - b.createdAt.getTime();
    if (byDate !== 0) return byDate;
    return a.id.localeCompare(b.id);
  });
  return sorted[0];
}

/** O5: distinct set keyed `${kind}:${last4}`, first-appearance order (O12). */
function dedupOrigins(refs: PaidOriginRef[]): PaidOriginRef[] {
  const seen = new Set<string>();
  const result: PaidOriginRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.last4}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}
