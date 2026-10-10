import {
  HttpException,
  HttpStatus,
  type ExecutionContext,
} from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import {
  AGENT_ADMISSION_CLOCK,
  type AgentAdmissionClock,
  SystemAgentAdmissionClock,
} from "./agent-admission-clock";
import { AgentChatThrottleGuard } from "./agent-chat-throttle.guard";
import { AgentDailyQuotaGuard } from "./agent-daily-quota.guard";
import { AgentModule } from "./agent.module";

const THROTTLE_MESSAGE =
  "Muitas requisições para o assistente. Tente novamente em instantes.";

class MutableAdmissionClock implements AgentAdmissionClock {
  constructor(public current: Date) {}

  now(): Date {
    return new Date(this.current);
  }
}

function context(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

function request(sequence = 0, ip = "203.0.113.10") {
  return {
    headers: { "fly-client-ip": ip },
    ip: "127.0.0.1",
    tenantId: `tenant-${sequence}`,
    user: { id: `user-${sequence}` },
  };
}

function expectThrottle(run: () => unknown): void {
  try {
    run();
    throw new Error("Expected the admission throttle to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect((error as HttpException).getResponse()).toBe(THROTTLE_MESSAGE);
  }
}

describe("Agent admission clock", () => {
  it.each([
    ["chat throttle", AgentChatThrottleGuard],
    ["daily quota", AgentDailyQuotaGuard],
  ])(
    "fails module compilation when %s has no clock provider",
    async (_, guard) => {
      await expect(
        Test.createTestingModule({
          providers: [
            guard,
            {
              provide: PrismaService,
              useValue: {
                agentDailyQuota: {
                  updateMany: jest.fn(),
                  create: jest.fn(),
                },
              },
            },
          ],
        }).compile(),
      ).rejects.toThrow(/AGENT_ADMISSION_CLOCK/);
    },
  );

  it("uses the system clock while admitting 30 and rejecting 31 with exact copy", () => {
    const guard = new AgentChatThrottleGuard(new SystemAgentAdmissionClock());
    const admission = context(request());

    for (let count = 0; count < 30; count += 1) {
      expect(guard.canActivate(admission)).toBe(true);
    }

    expectThrottle(() => guard.canActivate(admission));
  });

  it("blocks at 59,999ms and admits at exactly 60,000ms with fresh guards", () => {
    const runAtOffset = (offsetMs: number): boolean => {
      const clock = new MutableAdmissionClock(
        new Date("2026-10-09T23:30:00.000Z"),
      );
      const guard = new AgentChatThrottleGuard(clock);
      const admission = context(request());
      for (let count = 0; count < 30; count += 1) {
        expect(guard.canActivate(admission)).toBe(true);
      }
      clock.current = new Date(clock.current.getTime() + offsetMs);
      return guard.canActivate(admission);
    };

    expectThrottle(() => runAtOffset(59_999));
    expect(runAtOffset(60_000)).toBe(true);
  });

  it("admits 60 tenant/users on one IP and rejects 61 with exact copy", () => {
    const guard = new AgentChatThrottleGuard(
      new MutableAdmissionClock(new Date("2026-10-09T23:30:00.000Z")),
    );
    const ip = "198.51.100.12";

    for (let sequence = 0; sequence < 60; sequence += 1) {
      expect(guard.canActivate(context(request(sequence, ip)))).toBe(true);
    }

    expectThrottle(() => guard.canActivate(context(request(60, ip))));
  });

  it("derives the daily UTC key from the same required clock", async () => {
    const prisma = {
      agentDailyQuota: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn(),
      },
    };
    const clock = new MutableAdmissionClock(
      new Date("2026-10-10T00:01:00.000Z"),
    );
    const guard = new AgentDailyQuotaGuard(
      prisma as unknown as PrismaService,
      clock,
    );

    await expect(
      guard.canActivate(
        context({ user: { tenantId: "tenant-after-midnight" } }),
      ),
    ).resolves.toBe(true);
    expect(prisma.agentDailyQuota.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-after-midnight",
        dayKey: "2026-10-10",
        deletedAt: null,
        count: { lt: 30 },
      },
      data: { count: { increment: 1 } },
    });
  });

  it("binds exactly one system clock without a factory or value provider", () => {
    const providers: unknown[] =
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AgentModule) ?? [];
    const bindings = providers.filter(
      (provider): provider is Record<PropertyKey, unknown> =>
        typeof provider === "object" &&
        provider !== null &&
        (provider as Record<PropertyKey, unknown>)["provide"] ===
          AGENT_ADMISSION_CLOCK,
    );

    expect(bindings).toEqual([
      {
        provide: AGENT_ADMISSION_CLOCK,
        useClass: SystemAgentAdmissionClock,
      },
    ]);
    expect(bindings[0]).not.toHaveProperty("useFactory");
    expect(bindings[0]).not.toHaveProperty("useValue");
  });
});
