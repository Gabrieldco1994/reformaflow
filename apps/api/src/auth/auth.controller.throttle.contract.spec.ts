import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthController } from './auth.controller';

function methodGuardNames(methodName: 'login' | 'register' | 'registerGuest') {
  const method = AuthController.prototype[methodName] as unknown as object;
  const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, method) ?? [];
  return guards.map((guard) =>
    typeof guard === 'function'
      ? guard.name
      : (guard as object)?.constructor?.name ?? '',
  );
}

describe('AuthController throttle contract', () => {
  it('/auth/login mantém throttle', () => {
    expect(methodGuardNames('login').some((name) => /throttle/i.test(name))).toBe(
      true,
    );
  });

  it('/auth/register mantém throttle', () => {
    expect(
      methodGuardNames('register').some((name) => /throttle/i.test(name)),
    ).toBe(true);
  });

  it('/auth/guest mantém throttle', () => {
    expect(
      methodGuardNames('registerGuest').some((name) => /throttle/i.test(name)),
    ).toBe(true);
  });
});
