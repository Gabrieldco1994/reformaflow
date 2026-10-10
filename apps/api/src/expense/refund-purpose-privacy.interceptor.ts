import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from "@nestjs/common";
import { mergeMap } from "rxjs/operators";
import {
  canUseInlineProject,
  currentInlineRequester,
} from "../bank-account/inline-expenses";
import { PrismaService } from "../prisma/prisma.service";
import { RateioRequester } from "./rateio.types";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Ownership evidence must never escape through generic Prisma-shaped responses. */
export function omitRefundPurposeEvidence(
  value: unknown,
  hiddenReferences: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(value))
    return value.map((item) =>
      omitRefundPurposeEvidence(item, hiddenReferences),
    );
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            key !== "refundPurposeRevision" && key !== "isRefundCredit",
        )
        .map(([key, item]) => [
          key,
          key === "linkedExpenseId" &&
          typeof value.id === "string" &&
          hiddenReferences.has(value.id)
            ? null
            : omitRefundPurposeEvidence(item, hiddenReferences),
        ]),
    );
  }
  return value;
}

/** Read ACL, not deletion capability, governs disclosure of marked counterpart IDs. */
export async function serializeRefundPurposeResponse(
  prisma: PrismaService,
  tenantId: string | undefined,
  requester: RateioRequester | undefined,
  value: unknown,
): Promise<unknown> {
  const references: { id: string; linkedExpenseId: string }[] = [];
  const collect = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(collect);
    } else if (isPlainRecord(item)) {
      if (
        typeof item.id === "string" &&
        typeof item.linkedExpenseId === "string"
      )
        references.push({ id: item.id, linkedExpenseId: item.linkedExpenseId });
      Object.values(item).forEach(collect);
    }
  };
  collect(value);
  if (!references.length) return omitRefundPurposeEvidence(value);
  if (!tenantId) throw new UnauthorizedException("Sessão inválida");

  const hiddenReferences = await prisma.$transaction(async (tx) => {
    const ids = references.map((row) => row.id);
    const allocations = await tx.rateioAllocation.findMany({
      where: {
        tenantId,
        isRefundCredit: true,
        OR: [
          { sourceExpenseId: { in: ids } },
          { targetExpenseId: { in: ids } },
        ],
      },
      select: { sourceExpenseId: true, targetExpenseId: true },
    });
    const current = new Map(
      (
        await tx.expense.findMany({
          where: {
            tenantId,
            id: { in: ids },
            deletedAt: null,
            project: { tenantId, deletedAt: null },
          },
          select: {
            id: true,
            linkedExpenseId: true,
            refundPurposeRevision: true,
          },
        })
      ).map((row) => [row.id, row]),
    );
    const targets = new Map(
      allocations.map((edge) => [edge.sourceExpenseId, edge.targetExpenseId]),
    );
    // The response may predate undo. Its pointer must still be current; the
    // durable revision prevents a disappeared edge from becoming legacy proof.
    const hidden = new Set(
      references
        .filter((reference) => {
          const row = current.get(reference.id);
          return (
            !row ||
            row.linkedExpenseId !== reference.linkedExpenseId ||
            (row.refundPurposeRevision > 0 &&
              targets.get(row.id) !== reference.linkedExpenseId)
          );
        })
        .map((row) => row.id),
    );
    const participants = new Set(
      allocations.flatMap((allocation) => [
        allocation.sourceExpenseId,
        allocation.targetExpenseId,
      ]),
    );
    const marked = references.filter(
      (row) =>
        participants.has(row.id) ||
        (current.get(row.id)?.refundPurposeRevision ?? 0) > 0,
    );
    if (!marked.length) return hidden;
    if (!requester?.id) throw new UnauthorizedException("Sessão inválida");

    const actor = await currentInlineRequester(tx, tenantId, requester);
    const counterparts = await tx.expense.findMany({
      where: {
        tenantId,
        deletedAt: null,
        id: { in: marked.map((row) => row.linkedExpenseId) },
        project: { tenantId, deletedAt: null },
      },
      select: { id: true, project: { select: { id: true, type: true } } },
    });
    const visible = new Set(
      counterparts
        .filter((row) => canUseInlineProject(actor, row.project))
        .map((row) => row.id),
    );
    for (const row of marked) {
      if (!visible.has(row.linkedExpenseId)) hidden.add(row.id);
    }
    return hidden;
  });
  return omitRefundPurposeEvidence(value, hiddenReferences);
}

@Injectable()
export class RefundPurposePrivacyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{
      tenantId?: string;
      user?: RateioRequester & { tenantId?: string };
    }>();
    return next
      .handle()
      .pipe(
        mergeMap((value) =>
          serializeRefundPurposeResponse(
            this.prisma,
            request.user?.tenantId ?? request.tenantId,
            request.user,
            value,
          ),
        ),
      );
  }
}
