import { Test } from "@nestjs/testing";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { PrismaService } from "../prisma/prisma.service";
import { ExpenseService } from "./expense.service";

describe("ExpenseService Maria native planned-card entry point", () => {
  it("exposes the transaction-bound native card purchase writer", async () => {
    const module = await Test.createTestingModule({
      providers: [
        ExpenseService,
        ConciliacaoService,
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();

    try {
      const service = module.get(ExpenseService);
      const writer = Reflect.get(
        Object.getPrototypeOf(service),
        "createPlannedCardPurchaseInTx",
      );

      expect(typeof writer).toBe("function");
    } finally {
      await module.close();
    }
  });
});
