import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import * as bcrypt from "bcrypt";
import { AppModule } from "./app.module";
import { PrismaService } from "./prisma/prisma.service";
import {
  IMPORT_VAULT_GATE,
  ImportVaultGate,
} from "./imports/import-session/vault/vault-state";
import { verifyVaultStartup } from "./imports/import-session/vault/vault-startup";

export async function ensureBootstrapAdmin(
  prisma: PrismaService,
): Promise<void> {
  const logger = new Logger("Bootstrap");
  let username = process.env["ADMIN_USERNAME"];
  const password = process.env["ADMIN_PASSWORD"];

  if (!username && process.env["ADMIN_EMAIL"]) {
    const email = process.env["ADMIN_EMAIL"];
    const at = email.indexOf("@");
    username = at > 0 ? email.slice(0, at) : email;
    logger.warn(
      `ADMIN_EMAIL legado detectado, derivando ADMIN_USERNAME="${username}"`,
    );
  }

  let tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: "asc" } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: { id: "dev-tenant-1", name: "Default" },
    });
    logger.log(`Tenant default criado: ${tenant.id}`);
  }

  if (!username || !password) {
    logger.warn(
      "ADMIN_USERNAME/ADMIN_PASSWORD não definidos no .env — pulando bootstrap admin",
    );
    return;
  }

  const normalizedUsername = username.toLowerCase().trim();
  const existing = await prisma.user.findFirst({
    where: { tenantId: tenant.id, username: normalizedUsername },
  });

  if (existing) {
    const data: { role?: "ADMIN"; passwordHash?: string } = {};
    if (existing.role !== "ADMIN") {
      data.role = "ADMIN";
    }
    if (!existing.passwordHash) {
      data.passwordHash = await bcrypt.hash(password, 10);
    }
    if (Object.keys(data).length > 0) {
      await prisma.user.update({
        where: { id: existing.id },
        data,
      });
      logger.log(`Admin promovido/atualizado: ${normalizedUsername}`);
    } else {
      logger.log(`Admin já existe: ${normalizedUsername} (senha preservada)`);
    }
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: null,
      username: normalizedUsername,
      name: "Administrador",
      role: "ADMIN",
      passwordHash,
      allowedModules: "[]",
    },
  });
  logger.log(`Admin inicial criado: ${normalizedUsername}`);
}

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  if (process.env["IMPORT_VAULT_ENABLED"] === "true") {
    try {
      await verifyVaultStartup(process.env, process.cwd());
      const gate = app.get<ImportVaultGate>(IMPORT_VAULT_GATE);
      await gate.boot.settled;
      if (gate.boot.state() !== "ON") throw new Error("VAULT_STARTUP_REJECTED");
      new Logger("Bootstrap").log({ event: "vault_startup_gate", state: "ON" });
    } catch {
      new Logger("Bootstrap").error({
        event: "vault_startup_gate",
        state: "OFF",
      });
      await app.close();
      throw new Error("VAULT_STARTUP_REJECTED");
    }
  }

  // Behind proxy (Fly.io, Render, etc.) — needed for secure cookies + req.ip
  const httpAdapter = app.getHttpAdapter().getInstance();
  if (typeof httpAdapter?.set === "function") {
    httpAdapter.set("trust proxy", 1);
  }

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const corsOriginRaw = process.env["CORS_ORIGIN"] ?? "http://localhost:3000";
  const corsOrigins = corsOriginRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
    credentials: true,
  });

  const config = new DocumentBuilder()
    .setTitle("ReformaFlow API")
    .setDescription("API de Gestão Financeira de Reformas Residenciais")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, document);

  const prisma = app.get(PrismaService);
  await ensureBootstrapAdmin(prisma);

  await app.listen(process.env["PORT"] ?? 3001, "0.0.0.0");
}

if (require.main === module) {
  void bootstrap().catch(() => {
    process.exitCode = 1;
  });
}
