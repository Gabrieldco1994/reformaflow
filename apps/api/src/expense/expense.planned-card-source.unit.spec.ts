import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ExpenseType, ImportSessionPlannedCreateV1 } from "@reformaflow/domain";
import { Prisma, Project, CreditCard } from "@prisma/client";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { PrismaService } from "../prisma/prisma.service";
import { ExpenseService } from "./expense.service";
import {
  parseStoredExpenseSchedule,
  toPublicExpenseSchedule,
} from "./documented-schedule";
import { ScheduleEvidenceInput } from "./documented-schedule.types";
import { RateioRequester } from "./rateio.types";

type Input = Pick<
  ImportSessionPlannedCreateV1,
  | "titulo"
  | "fornecedor"
  | "tipoDespesa"
  | "categoriaMaoDeObra"
  | "dataCompra"
  | "totalCents"
  | "schedule"
> & { cardId: string; evidence: ScheduleEvidenceInput; reason: string };

const tenantId = "planned-unit-tenant";
const ownerProjectId = "planned-unit-owner";
const actorId = "planned-unit-actor";
const cardId = "planned-unit-card";
const now = new Date("2026-10-07T03:00:00.000Z");
const requester: RateioRequester = { id: actorId, role: "OWNER" };
const project: Project = {
  id: ownerProjectId,
  tenantId,
  type: "PESSOAL",
  name: "Fixture",
  createdByUserId: actorId,
  description: null,
  startDate: null,
  endDate: null,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  onboardedAt: null,
};
const card: CreditCard = {
  id: cardId,
  tenantId,
  projectId: ownerProjectId,
  institution: "OUTROS",
  brand: "Outros",
  nickname: "Fixture",
  last4: "4321",
  closingDay: 20,
  dueDay: 5,
  limitTotalCents: null,
  limitAvailableCents: null,
  notes: null,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};
const user: Prisma.UserGetPayload<{ include: { tenant: true } }> = {
  id: actorId,
  tenantId,
  username: actorId,
  name: "Fixture",
  role: "OWNER",
  email: null,
  passwordHash: null,
  externalId: null,
  isGuest: false,
  allowedProjects: "[]",
  allowedProjectTypes: "[]",
  allowedModules: "[]",
  createdByUserId: null,
  sessionVersion: 0,
  lastLoginAt: null,
  lastActivityAt: null,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  tenant: {
    id: tenantId,
    name: "Fixture",
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  },
};

function input(): Input {
  return {
    titulo: "Fixture purchase",
    fornecedor: null,
    tipoDespesa: ExpenseType.OUTROS,
    categoriaMaoDeObra: null,
    dataCompra: "2026-10-06",
    totalCents: 10001,
    cardId,
    schedule: {
      version: 1,
      occurrences: [
        {
          index: 0,
          parcela: "2/3",
          valor: 5000,
          data: "2026-10-06",
          invoiceDueMonth: "2026-11",
        },
        {
          index: 1,
          parcela: "3/3",
          valor: 5001,
          data: "2026-11-06",
          invoiceDueMonth: "2026-12",
        },
      ],
    },
    evidence: {
      documentSha256: "a".repeat(64),
      reference: "synthetic fixture page 1",
    },
    reason: "Explicit documentary schedule",
  };
}

describe("ExpenseService planned-card source input/core contract (unit)", () => {
  const prisma = new PrismaService();
  const service = new ExpenseService(prisma, new ConciliacaoService(prisma));
  const insertBoundary = new Error("unit stops before INSERT");
  let insert: jest.SpiedFunction<typeof prisma.expense.create>;

  beforeAll(async () => {
    await prisma.$connect();
    const rows = await prisma.$queryRaw<
      Array<{ foreign_keys: bigint }>
    >`PRAGMA foreign_keys`;
    expect(Number(rows[0].foreign_keys)).toBe(1);
  });
  afterAll(async () => prisma.$disconnect());
  beforeEach(() => {
    jest.spyOn(prisma.user, "findUnique").mockResolvedValue(user);
    jest.spyOn(prisma.project, "findFirst").mockResolvedValue(project);
    jest.spyOn(prisma.creditCard, "findFirst").mockResolvedValue(card);
    insert = jest
      .spyOn(prisma.expense, "create")
      .mockRejectedValue(insertBoundary);
  });
  afterEach(() => jest.restoreAllMocks());

  const create = (value = input(), actor = requester, createdBy = actorId) =>
    service.createPlannedCardPurchaseInTx(
      prisma,
      tenantId,
      ownerProjectId,
      value,
      createdBy,
      actor,
    );

  it("passes exact cents and validated V2 to the FIRST insert without exposing private DTO fields", async () => {
    const value = input();
    await expect(create(value)).rejects.toBe(insertBoundary);
    expect(insert).toHaveBeenCalledTimes(1);
    const data = insert.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId,
      projectId: ownerProjectId,
      createdByUserId: actorId,
      valor: 10001,
      valorTotal: 10001,
      quantidade: 1,
      status: "PLANEJADO",
      formaPagamento: "PARCELADO",
      quantidadeParcela: 2,
      cardLast4: "4321",
      dataCompra: new Date("2026-10-06"),
      dataInicioParcela: new Date("2026-10-06"),
    });
    expect(data.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const stored = parseStoredExpenseSchedule(data.documentedSchedule);
    expect(stored).toMatchObject({
      version: 2,
      kind: "source",
      sourceExpenseId: data.id,
      sourceProjectId: ownerProjectId,
      tenantId,
      cardId,
      recordedByUserId: actorId,
      projections: [],
      lastOperation: null,
      provenance: {
        kind: "assisted-card",
        basis: "no-import-reference",
        originalImportId: null,
        originalExternalId: null,
        referenceCheck: "NO_REFERENCE",
        reason: value.reason,
        evidence: { ...value.evidence, actorUserId: actorId },
      },
    });
    expect(toPublicExpenseSchedule(stored)).toEqual(value.schedule);
    expect(stored?.occurrences).toEqual(
      value.schedule.occurrences.map((occurrence) => ({
        ...occurrence,
        amountEvidence: {
          ...value.evidence,
          actorUserId: actorId,
          recordedAt: stored?.recordedAt,
        },
        cycleEvidence: {
          ...value.evidence,
          actorUserId: actorId,
          recordedAt: stored?.recordedAt,
        },
      })),
    );
    expect(data.importId).toBeUndefined();
    expect(data.externalId).toBeUndefined();
    expect(data.paidParcelas).toBeUndefined();
    expect(data.settlesInvoiceKey).toBeUndefined();
    expect(value).toEqual(input());
  });

  it("preserves a single explicit occurrence without inferring its invoice month", async () => {
    const value = input();
    value.schedule.occurrences = [
      {
        index: 0,
        parcela: null,
        valor: 10001,
        data: "2026-10-06",
        invoiceDueMonth: "2027-02",
      },
    ];
    await expect(create(value)).rejects.toBe(insertBoundary);
    const data = insert.mock.calls[0][0].data;
    expect(data.formaPagamento).toBe("A_VISTA");
    expect(data.dataPagamento).toEqual(new Date("2026-10-06"));
    expect(
      toPublicExpenseSchedule(
        parseStoredExpenseSchedule(data.documentedSchedule),
      ),
    ).toEqual(value.schedule);
  });

  it.each([
    [
      "sum mismatch",
      (value: Input) => {
        value.totalCents++;
      },
    ],
    [
      "fractional cents",
      (value: Input) => {
        value.totalCents = 10001.5;
      },
    ],
    [
      "zero total",
      (value: Input) => {
        value.totalCents = 0;
        value.schedule.occurrences[0].valor = 0;
        value.schedule.occurrences[1].valor = 0;
      },
    ],
    [
      "negative total",
      (value: Input) => {
        value.totalCents = -10001;
        value.schedule.occurrences[0].valor = -5000;
        value.schedule.occurrences[1].valor = -5001;
      },
    ],
    [
      "invalid purchase date",
      (value: Input) => {
        value.dataCompra = "2026-02-30";
      },
    ],
  ])("rejects %s before insert", async (_name, mutate) => {
    const value = input();
    mutate(value);
    await expect(create(value)).rejects.toBeInstanceOf(BadRequestException);
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([
    [
      "empty schedule",
      (value: Input) => {
        value.schedule.occurrences = [];
      },
    ],
    [
      "invalid occurrence date",
      (value: Input) => {
        value.schedule.occurrences[0].data = "2026-02-30";
      },
    ],
    [
      "invalid index",
      (value: Input) => {
        value.schedule.occurrences[0].index = 1;
      },
    ],
    [
      "invalid cycle",
      (value: Input) => {
        value.schedule.occurrences[0].invoiceDueMonth = "2026-13";
      },
    ],
    [
      "missing evidence",
      (value: Input) => {
        value.evidence.reference = "";
      },
    ],
    [
      "invalid evidence hash",
      (value: Input) => {
        value.evidence.documentSha256 = "invalid";
      },
    ],
    [
      "empty reason",
      (value: Input) => {
        value.reason = " ";
      },
    ],
  ])("uses native validators for %s before insert", async (_name, mutate) => {
    const value = input();
    mutate(value);
    await expect(create(value)).rejects.toBeInstanceOf(RangeError);
    expect(insert).not.toHaveBeenCalled();
  });

  it("validates current actor identity, tenant and grants rather than trusting the supplied role", async () => {
    jest
      .mocked(prisma.user.findUnique)
      .mockResolvedValue({ ...user, tenantId: "foreign-tenant" });
    await expect(create()).rejects.toBeInstanceOf(UnauthorizedException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a createdBy different from the authenticated actor", async () => {
    await expect(
      create(input(), requester, "different-actor"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a missing requester identity", async () => {
    await expect(create(input(), {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("enforces the persisted project grant even if the supplied requester says OWNER", async () => {
    jest.mocked(prisma.user.findUnique).mockResolvedValue({
      ...user,
      role: "USER",
      allowedProjects: '["other-project"]',
    });
    await expect(create()).rejects.toBeInstanceOf(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("scopes the explicit card to tenant, owner project and active state", async () => {
    jest.mocked(prisma.creditCard.findFirst).mockResolvedValue(null);
    await expect(create()).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.creditCard.findFirst).toHaveBeenCalledWith({
      where: {
        id: cardId,
        tenantId,
        projectId: ownerProjectId,
        deletedAt: null,
      },
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("requires the current card module grant as well as expenses", async () => {
    jest.mocked(prisma.user.findUnique).mockResolvedValue({
      ...user,
      role: "USER",
      allowedModules: '["expenses"]',
    });
    await expect(create()).rejects.toBeInstanceOf(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects an unavailable owner project before insert", async () => {
    jest.mocked(prisma.project.findFirst).mockResolvedValue(null);
    await expect(create()).rejects.toBeInstanceOf(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("keeps public create money, status and private-field exclusion unchanged", async () => {
    const dto = {
      tipoDespesa: ExpenseType.OUTROS,
      valor: 12.345,
      quantidade: 3,
      status: "PAGO",
      formaPagamento: "PIX",
      id: "untrusted-id",
      documentedSchedule: "untrusted-schedule",
    };
    await expect(
      service.create(tenantId, ownerProjectId, dto, actorId, prisma),
    ).rejects.toBe(insertBoundary);
    const data = insert.mock.calls[0][0].data;
    expect(data).toMatchObject({
      valor: 1235,
      quantidade: 3,
      valorTotal: 3705,
      status: "PAGO",
      formaPagamento: "PIX",
    });
    expect(data.id).toBeUndefined();
    expect(data.documentedSchedule).toBeUndefined();
  });
});
