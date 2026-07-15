import { HttpException, HttpStatus } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { LoginThrottleGuard } from "./login-throttle.guard";

function ctx(req: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as ExecutionContext;
}

describe("LoginThrottleGuard", () => {
  let guard: LoginThrottleGuard;

  beforeEach(() => {
    guard = new LoginThrottleGuard();
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => jest.useRealTimers());

  it("bloqueia a 11ª tentativa no mesmo IP+username", () => {
    const request = {
      headers: { "fly-client-ip": "203.0.113.10" },
      body: { username: "user@example.com" },
      ip: "127.0.0.1",
    };

    for (let i = 0; i < 10; i++) {
      expect(guard.canActivate(ctx(request))).toBe(true);
    }

    expect(() => guard.canActivate(ctx(request))).toThrow(
      expect.objectContaining({
        status: HttpStatus.TOO_MANY_REQUESTS,
      }),
    );
  });

  it("bloqueia pelo limite por usuário mesmo com rotação de IP", () => {
    const username = "same-user@example.com";

    for (let i = 0; i < 30; i++) {
      const request = {
        headers: { "fly-client-ip": `203.0.113.${i}` },
        body: { username },
        ip: "127.0.0.1",
      };
      expect(guard.canActivate(ctx(request))).toBe(true);
    }

    const request31 = {
      headers: { "fly-client-ip": "198.51.100.200" },
      body: { username },
      ip: "127.0.0.1",
    };

    try {
      guard.canActivate(ctx(request31));
      throw new Error("expected throttle");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  });

  it("usa IP confiável (lado direito de X-Forwarded-For) contra spoof de client", () => {
    for (let i = 0; i < 10; i++) {
      const request = {
        headers: { "x-forwarded-for": `10.0.0.${i}, 198.51.100.77` },
        body: { username: "xff-user@example.com" },
        ip: "127.0.0.1",
      };
      expect(guard.canActivate(ctx(request))).toBe(true);
    }

    const throttled = {
      headers: { "x-forwarded-for": "203.0.113.20, 198.51.100.77" },
      body: { username: "xff-user@example.com" },
      ip: "127.0.0.1",
    };

    expect(() => guard.canActivate(ctx(throttled))).toThrow(HttpException);
  });

  it("libera novamente após expirar a janela de 10 minutos", () => {
    const request = {
      headers: { "fly-client-ip": "203.0.113.10" },
      body: { username: "window@example.com" },
      ip: "127.0.0.1",
    };

    for (let i = 0; i < 10; i++) guard.canActivate(ctx(request));
    expect(() => guard.canActivate(ctx(request))).toThrow(HttpException);

    jest.advanceTimersByTime(10 * 60 * 1000 + 1);

    expect(guard.canActivate(ctx(request))).toBe(true);
  });
});
