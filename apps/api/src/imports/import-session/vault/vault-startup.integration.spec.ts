import { NestFactory } from "@nestjs/core";
import { SwaggerModule } from "@nestjs/swagger";
import { bootstrap } from "../../../main";
import { IMPORT_VAULT_GATE } from "./vault-state";
import { PrismaService } from "../../../prisma/prisma.service";

jest.mock("@nestjs/core", () => ({
  NestFactory: { create: jest.fn() },
}));
jest.mock("@nestjs/swagger", () => ({
  ...jest.requireActual("@nestjs/swagger"),
  SwaggerModule: { createDocument: jest.fn(), setup: jest.fn() },
}));
jest.mock("./vault-startup", () => ({ verifyVaultStartup: jest.fn() }));

describe("actual bootstrap requested-ON gate", () => {
  const savedEnv = process.env;
  const gate = {
    boot: { settled: Promise.resolve(), state: jest.fn(), reason: "NO_FDINFO" },
  };
  const prisma = { tenant: { findFirst: jest.fn() } };
  const app = {
    getHttpAdapter: () => ({ getInstance: () => ({ set: jest.fn() }) }),
    use: jest.fn(),
    useGlobalPipes: jest.fn(),
    enableCors: jest.fn(),
    enableShutdownHooks: jest.fn(),
    get: jest.fn((token: unknown) =>
      token === IMPORT_VAULT_GATE
        ? gate
        : token === PrismaService
          ? prisma
          : null,
    ),
    listen: jest.fn(),
    close: jest.fn(),
  };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { IMPORT_VAULT_ENABLED: "true" };
    (NestFactory.create as jest.Mock).mockResolvedValue(app);
    (SwaggerModule.createDocument as jest.Mock).mockReturnValue({});
    prisma.tenant.findFirst.mockResolvedValue({ id: "synthetic-tenant" });
    gate.boot.state.mockReturnValue("OFF");
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  it("requested ON failing physical proof closes before bootstrap administration/listen", async () => {
    await expect(bootstrap()).rejects.toThrow("VAULT_STARTUP_REJECTED");
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(app.listen).not.toHaveBeenCalled();
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });

  it("waits for the actual gate, not helper success", async () => {
    let settle!: () => void;
    gate.boot.settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const pending = bootstrap();
    await Promise.resolve();
    await Promise.resolve();
    expect(app.listen).not.toHaveBeenCalled();
    gate.boot.state.mockReturnValue("ON");
    settle();
    await pending;
    expect(app.listen).toHaveBeenCalledTimes(1);
    expect(app.enableShutdownHooks).toHaveBeenCalledTimes(1);
    gate.boot.settled = Promise.resolve();
  });

  it.each([undefined, "false", "TRUE", "1", ""])(
    "OFF %s keeps compatibility and installs shutdown hooks",
    async (flag) => {
      process.env.IMPORT_VAULT_ENABLED = flag;
      await bootstrap();
      expect(app.listen).toHaveBeenCalledTimes(1);
      expect(app.enableShutdownHooks).toHaveBeenCalledTimes(1);
    },
  );
});
