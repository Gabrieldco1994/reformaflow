import type { ExecutionContext } from "@nestjs/common";
import { JwtStrategy } from "./jwt.strategy";
import {
  ImportAuthGuard,
  readImportAuthForRequest,
} from "../imports/import-session/import-session.auth";

describe("verified JWT import authority", () => {
  const user = {
    id: "user-claims",
    tenantId: "tenant-claims",
    username: "claims",
    role: "USER",
    deletedAt: null,
    sessionVersion: 3,
    allowedModules: "[]",
    allowedProjects: "[]",
    allowedProjectTypes: "[]",
    lastActivityAt: new Date(),
    tenant: { deletedAt: null },
  };
  const strategy = (): JwtStrategy =>
    new JwtStrategy({
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    } as never);
  const context = (request: object): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
    }) as ExecutionContext;

  it("carries presented sv/exp, never body/header tenant or refreshed expiry", async () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const verified = await strategy().validate({
      sub: user.id,
      tenantId: user.tenantId,
      username: user.username,
      role: "USER",
      sv: 3,
      exp: expires,
    });
    const request = {
      user: verified,
      body: { tenantId: "attacker" },
      headers: { "x-tenant-id": "attacker" },
    };
    expect(new ImportAuthGuard().canActivate(context(request))).toBe(true);
    expect(readImportAuthForRequest(request)).toEqual({
      userId: user.id,
      tenantId: user.tenantId,
      presentedSessionVersion: 3,
      tokenExpiresAt: new Date(expires * 1000).toISOString(),
    });
  });

  it("does not invent an expiration for legacy tokens", async () => {
    const verified = await strategy().validate({
      sub: user.id,
      tenantId: user.tenantId,
      username: user.username,
      role: "USER",
      sv: 3,
    });
    expect(() =>
      new ImportAuthGuard().canActivate(context({ user: verified })),
    ).toThrow();
  });
});
