import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { resolveAccessibleProjectScope } from '../common/access-rules';
import { buildPaidOrigins } from './paid-origins.builder';
import {
  BuildPaidOriginsInput,
  PaidOriginLinkRow,
  PaidOriginRateioRow,
  PaidOriginSettlementRow,
  PaidOriginSourceRow,
  PaidOriginsResponse,
  PaidOriginsViewer,
} from './paid-origins.types';

export interface PaidOriginsRequester {
  id: string;
  role: string | undefined;
  allowedProjects?: string[];
  allowedProjectTypes?: string[];
  allowedModules?: string[];
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

/**
 * Read-only orchestration for GET .../expenses/paid-origins (#424). Runs a
 * bounded, O(1)-in-N set of queries (≤7, see docs/quitacao-parcela-cross-
 * project.md §10) and delegates ALL derivation/redaction to the pure
 * `buildPaidOrigins` builder. NEVER writes (O1) — no `$transaction`, no
 * mutation call on any model.
 */
@Injectable()
export class PaidOriginsService {
  constructor(private readonly prisma: PrismaService) {}

  async findForProject(
    tenantId: string,
    projectId: string,
    requester: PaidOriginsRequester,
  ): Promise<PaidOriginsResponse> {
    const allowedModules = Array.isArray(requester.allowedModules) ? requester.allowedModules : [];

    const [settlementRows, rateioRows, projectScope, projectExpenseIdRows] = await Promise.all([
      this.prisma.crossProjectSettlement.findMany({
        where: { tenantId, target: { projectId, tenantId, deletedAt: null } },
        select: { targetExpenseId: true, sourceExpenseId: true, parcelaIndex: true },
      }),
      this.prisma.rateioAllocation.findMany({
        where: { tenantId, target: { projectId, tenantId, deletedAt: null } },
        select: { targetExpenseId: true, sourceExpenseId: true },
      }),
      resolveAccessibleProjectScope(
        this.prisma,
        tenantId,
        requester.role,
        requester.allowedProjects,
        requester.allowedProjectTypes,
        allowedModules,
      ),
      this.prisma.expense.findMany({
        where: { projectId, tenantId, deletedAt: null },
        select: { id: true },
      }),
    ]);

    const settlements: PaidOriginSettlementRow[] = settlementRows;
    const rateios: PaidOriginRateioRow[] = rateioRows;

    const coveredTargets = new Set<string>([
      ...settlements.map((row) => row.targetExpenseId),
      ...rateios.map((row) => row.targetExpenseId),
    ]);
    const uncoveredTargetIds = projectExpenseIdRows
      .map((row) => row.id)
      .filter((id) => !coveredTargets.has(id));

    const linkRows =
      uncoveredTargetIds.length > 0
        ? await this.prisma.expense.findMany({
            where: { tenantId, deletedAt: null, linkedExpenseId: { in: uncoveredTargetIds } },
            select: { id: true, linkedExpenseId: true },
          })
        : [];
    const links: PaidOriginLinkRow[] = linkRows.map((row: { id: string; linkedExpenseId: string | null }) => ({
      targetExpenseId: row.linkedExpenseId as string,
      sourceExpenseId: row.id,
    }));

    const sourceIds = unique([
      ...settlements.map((row) => row.sourceExpenseId),
      ...rateios.map((row) => row.sourceExpenseId),
      ...links.map((row) => row.sourceExpenseId),
    ]);

    const sourceRows =
      sourceIds.length > 0
        ? await this.prisma.expense.findMany({
            where: { id: { in: sourceIds }, tenantId, deletedAt: null },
            select: {
              id: true,
              projectId: true,
              cardLast4: true,
              bankLast4: true,
              accountId: true,
              project: { select: { id: true, name: true, type: true } },
            },
          })
        : [];

    const sources: PaidOriginSourceRow[] = sourceRows.map(
      (row: {
        id: string;
        projectId: string;
        cardLast4: string | null;
        bankLast4: string | null;
        accountId: string | null;
        project: { id: string; name: string; type: string };
      }) => ({
        id: row.id,
        projectId: row.projectId,
        projectName: row.project.name,
        projectType: row.project.type,
        cardLast4: row.cardLast4,
        bankLast4: row.bankLast4,
        accountId: row.accountId,
      }),
    );

    const cardLast4s = unique(
      sources.map((source) => source.cardLast4).filter((value): value is string => !!value),
    );
    const accountIds = unique(
      sources.map((source) => source.accountId).filter((value): value is string => !!value),
    );
    const bankLast4s = unique(
      sources.map((source) => source.bankLast4).filter((value): value is string => !!value),
    );

    const [cards, accounts] = await Promise.all([
      cardLast4s.length > 0
        ? this.prisma.creditCard.findMany({
            where: { tenantId, deletedAt: null, last4: { in: cardLast4s } },
            select: { id: true, projectId: true, last4: true, nickname: true, brand: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
        : Promise.resolve([]),
      accountIds.length > 0 || bankLast4s.length > 0
        ? this.prisma.bankAccount.findMany({
            where: {
              tenantId,
              deletedAt: null,
              OR: [{ id: { in: accountIds } }, { last4: { in: bankLast4s } }],
            },
            select: {
              id: true,
              projectId: true,
              last4: true,
              nickname: true,
              institution: true,
              createdAt: true,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
        : Promise.resolve([]),
    ]);

    const viewer: PaidOriginsViewer = {
      role: requester.role,
      allowedModules,
      projectScope,
    };

    const builderInput: BuildPaidOriginsInput = {
      settlements,
      rateios,
      links,
      sources,
      cards,
      accounts,
      viewer,
    };

    return { items: buildPaidOrigins(builderInput) };
  }
}
