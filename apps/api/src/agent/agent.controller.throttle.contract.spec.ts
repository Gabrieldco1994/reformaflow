import "reflect-metadata";
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
} from "@nestjs/common/constants";
import { AgentController } from "./agent.controller";
import { TenantInterceptor } from "../common/interceptors/tenant.interceptor";

describe("AgentController /agent/chat hardening contract", () => {
  it("controller mantém TenantInterceptor", () => {
    const interceptors: unknown[] =
      Reflect.getMetadata(INTERCEPTORS_METADATA, AgentController) ?? [];
    const names = interceptors.map((i) =>
      typeof i === "function" ? i.name : (i as object)?.constructor?.name,
    );

    expect(names).toContain(TenantInterceptor.name);
  });

  it("/agent/chat deve estar protegido por guard de throttle", () => {
    const guards: unknown[] =
      Reflect.getMetadata(GUARDS_METADATA, AgentController.prototype.chat) ??
      [];
    const names = guards.map((g) =>
      typeof g === "function" ? g.name : (g as object)?.constructor?.name,
    );

    expect(names.some((name) => /throttle/i.test(name))).toBe(true);
  });
});
