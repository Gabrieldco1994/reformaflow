import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../app.module";
import { ImportSessionModule } from "./import-session.module";
import { PrismaService } from "../../prisma/prisma.service";
import { ImportSessionService } from "./import-session.service";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
import { VaultRetentionScheduler } from "./vault/vault-retention.scheduler";

describe("import runtime registration", () => {
  it("registers the module on the production application", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)).toContain(
      ImportSessionModule,
    );
  });
  it("resolves the real module, auth boundary, workflow and scheduled cleanup with vault OFF", async () => {
    const module = await Test.createTestingModule({
      imports: [ImportSessionModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    try {
      expect(module.get(ImportSessionService)).toBeDefined();
      expect(module.get(ImportSessionWorkflowService)).toBeDefined();
      expect(module.get(VaultRetentionScheduler)).toBeDefined();
    } finally {
      await module.close();
    }
  });
});
