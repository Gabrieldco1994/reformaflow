// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../../scripts/test-db-env.cjs');

import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger, Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import cookieParser from 'cookie-parser';
import { AuthModule } from '../../auth/auth.module';
import { AuthService } from '../../auth/auth.service';
import { ActivityLogInterceptor } from '../../common/interceptors/activity-log.interceptor';
import { FinancialScheduleResponseInterceptor } from '../../common/interceptors/financial-schedule-response.interceptor';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ModulesGuard } from '../../common/guards/modules.guard';
import { ProjectAccessGuard } from '../../common/guards/project-access.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import {
  cleanupImportWorld,
  EMPTY_DRAFT_JSON,
  seedImportWorld,
  seedSession,
  SEVEN_DAYS_MS,
  type ImportWorld,
} from '../../test-utils/import-session-harness';
import {
  IMPORT_SESSION_CAPABILITY,
  type ImportSessionCapability,
} from "./import-session.capability";
import { IMPORT_SESSION_UI_ORIGINS } from './import-session-ui.guard';
import { ImportSessionModule } from './import-session.module';
import { ImportUiGrantIssuer } from './import-session-ui-grant';
import { IMPORT_VAULT_GATE } from './vault/vault-state';

/**
 * B1a — HTTP boundary with the REAL JwtStrategy and the REAL global guards
 * (Jwt/Roles/Modules/ProjectAccess) and interceptors, no mocks. The requests are
 * plain node:http (the repo has no supertest and this slice adds no dependency).
 */
const PREFIX = 'imp-http';
const ORIGIN = 'http://localhost:3000';
const EVIL = 'https://evil.example';
const setup = new PrismaClient();
const capability: ImportSessionCapability & { on: boolean } = {
  on: false,
  writesEnabled() {
    return this.on;
  },
  newImportFormats() {
    return this.on ? (['CSV'] as const) : ([] as const);
  },
};
const vaultRuntime = Object.freeze({
  config: Object.freeze({
    configured: true as const,
    rootDir: '/test/import-vault',
    lockFd: 7,
    idleTimeoutMs: 1,
    headroomBytes: 1,
    drainTimeoutMs: 1,
  }),
  lockIdentity: Object.freeze({ dev: 1n, ino: 1n }),
});
const vaultStopped = new AbortController();
const vaultGate = {
  boot: {
    state: () => 'ON' as const,
    runtime: () => vaultRuntime,
    stopped: vaultStopped.signal,
    settled: Promise.resolve(),
    recheckLock: async () => ({ ok: true as const, runtime: vaultRuntime }),
  },
  onModuleInit: async () => undefined,
  onModuleDestroy: async () => undefined,
};
let world: ImportWorld;
let app: INestApplication;
let baseUrl: { port: number };
let auth: AuthService;
let previousCors: string | undefined;

@Module({
  imports: [PrismaModule, AuthModule, ImportSessionModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: FinancialScheduleResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ActivityLogInterceptor },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ModulesGuard },
    { provide: APP_GUARD, useClass: ProjectAccessGuard },
  ],
})
class HttpTestModule {}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}
function call(method: string, path: string, options: { token?: string; cookie?: string; headers?: Record<string, string>; body?: unknown; contentType?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (payload !== undefined) {
      headers['content-type'] = options.contentType ?? 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    if (options.token) headers['authorization'] = `Bearer ${options.token}`;
    if (options.cookie) headers['cookie'] = `rf_token=${options.cookie}`;
    const req = http.request({ host: '127.0.0.1', port: baseUrl.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const UI = { origin: ORIGIN, 'x-rf-import-ui': '1' };
const wire = (code: string, extra: Partial<{ sessionId: string | null; currentRevision: number | null; retryable: boolean }> = {}) => ({ code, retryable: false, sessionId: null, currentRevision: null, reason: null, ...extra });

const tokenFor = async (userId: string) => auth.issueToken(await setup.user.findUniqueOrThrow({ where: { id: userId } }));
const secret = () => process.env['JWT_SECRET'] ?? 'dev-secret-change-me';
const liveSession = (extra: Record<string, unknown> = {}) => seedSession(setup, world, { expiresAt: new Date(Date.now() + SEVEN_DAYS_MS), ...extra });
const createBody = (cardId: string, requestId = randomUUID()) => ({ version: 1, createRequestId: requestId, cardId, consentPolicyVersion: 1, consentAnalyze: true });

describe('B1a — HTTP boundary (real JwtStrategy + real global guards)', () => {
  beforeAll(async () => {
    previousCors = process.env['CORS_ORIGIN'];
    process.env['CORS_ORIGIN'] = ORIGIN;
    await setup.$connect();
    world = await seedImportWorld(setup, PREFIX);
    const moduleRef = await Test.createTestingModule({ imports: [HttpTestModule] })
      .overrideProvider(IMPORT_SESSION_CAPABILITY)
      .useValue(capability)
      .overrideProvider(IMPORT_VAULT_GATE)
      .useValue(vaultGate)
      .overrideProvider(IMPORT_SESSION_UI_ORIGINS)
      .useValue({ allowed: () => [ORIGIN] })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.enableCors({ origin: ORIGIN, credentials: true });
    await app.listen(0, '127.0.0.1');
    baseUrl = app.getHttpServer().address() as AddressInfo;
    auth = app.get(AuthService);
  });
  beforeEach(async () => {
    capability.on = false;
    await setup.importSessionArtifact.deleteMany({ where: { tenantId: world.tenantId } });
    await setup.importSession.deleteMany({ where: { tenantId: world.tenantId } });
    await setup.user.updateMany({ where: { tenantId: world.tenantId }, data: { sessionVersion: 0 } });
  });
  afterAll(async () => {
    await app.close();
    await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
    if (previousCors === undefined) delete process.env['CORS_ORIGIN'];
    else process.env['CORS_ORIGIN'] = previousCors;
  });

  describe('authentication', () => {
    it('answers a typed 401 UNAUTHENTICATED on every route without a valid JWT', async () => {
      const id = randomUUID();
      const forged = new JwtService({ secret: 'not-the-secret' }).sign({ sub: world.users.owner.id, tenantId: world.tenantId, username: 'x', role: 'OWNER', sv: 0 }, { expiresIn: 60 });
      for (const token of [undefined, 'garbage', forged]) {
        const replies = await Promise.all([
          call('POST', '/import-sessions', { token, headers: UI, body: createBody(world.cards.pessoal) }),
          call('GET', `/import-sessions/${id}`, { token }),
          call('GET', `/import-sessions/${id}/result`, { token }),
          call('POST', `/import-sessions/${id}/cancel`, { token, headers: UI, body: { expectedRevision: 1 } }),
        ]);
        for (const reply of replies) {
          expect(reply.status).toBe(401);
          expect(reply.json).toEqual(wire('UNAUTHENTICATED'));
        }
      }
      expect(await setup.importSession.count({ where: { tenantId: world.tenantId } })).toBe(0);
    });

    it('accepts the rf_token cookie and the bearer header alike', async () => {
      const session = await liveSession();
      const token = await tokenFor(world.users.owner.id);
      expect((await call('GET', `/import-sessions/${session.id}`, { cookie: token })).status).toBe(200);
      expect((await call('GET', `/import-sessions/${session.id}`, { token })).status).toBe(200);
    });

    it('rejects a token whose sv no longer matches (force-logout) with 401', async () => {
      const session = await liveSession();
      const token = await tokenFor(world.users.owner.id);
      await setup.user.update({ where: { id: world.users.owner.id }, data: { sessionVersion: { increment: 1 } } });
      const reply = await call('GET', `/import-sessions/${session.id}`, { token });
      expect(reply.status).toBe(401);
      expect(reply.json).toEqual(wire('UNAUTHENTICATED'));
    });

    it('a legacy token WITHOUT sv is version 0 globally and reads normally', async () => {
      const session = await liveSession();
      const legacy = new JwtService({ secret: secret() }).sign({ sub: world.users.owner.id, tenantId: world.tenantId, username: 'x', role: 'OWNER' }, { expiresIn: 600 });
      expect((await call('GET', `/import-sessions/${session.id}`, { token: legacy })).status).toBe(200);
    });

    it('a token WITHOUT exp is refused by the import boundary but legacy routes keep working', async () => {
      const session = await liveSession();
      const noExp = new JwtService({ secret: secret() }).sign({ sub: world.users.owner.id, tenantId: world.tenantId, username: 'x', role: 'OWNER', sv: 0 });
      const reply = await call('GET', `/import-sessions/${session.id}`, { token: noExp });
      expect(reply.status).toBe(401);
      expect(reply.json).toEqual(wire('UNAUTHENTICATED'));
      expect((await call('GET', '/auth/me', { token: noExp })).status).toBe(200);
    });

    it('does not expose authClaims (sv/exp) through /auth/me or any import response', async () => {
      const session = await liveSession();
      const token = await tokenFor(world.users.owner.id);
      const me = await call('GET', '/auth/me', { token });
      expect(me.status).toBe(200);
      expect(me.text).not.toContain('authClaims');
      const read = await call('GET', `/import-sessions/${session.id}`, { token });
      expect(read.text).not.toContain('authClaims');
      expect(read.text).not.toContain('sessionVersion');
    });

    it('takes the tenant from the token even when ALLOW_TENANT_OVERRIDE=1 and header/query name another tenant', async () => {
      const previous = process.env['ALLOW_TENANT_OVERRIDE'];
      process.env['ALLOW_TENANT_OVERRIDE'] = '1';
      try {
        const session = await liveSession({ ownerUserId: world.users.owner.id });
        const foreign = await tokenFor(world.users.foreign.id);
        const owner = await tokenFor(world.users.owner.id);
        const viaHeader = await call('GET', `/import-sessions/${session.id}`, { token: foreign, headers: { 'x-tenant-id': world.tenantId } });
        const viaQuery = await call('GET', `/import-sessions/${session.id}?tenantId=${world.tenantId}`, { token: foreign });
        const viaBoth = await call('GET', `/import-sessions/${session.id}/result?tenantId=${world.tenantId}`, { token: foreign, headers: { 'x-tenant-id': world.tenantId } });
        expect([viaHeader, viaQuery, viaBoth].map((reply) => [reply.status, reply.json])).toEqual([
          [404, wire('NOT_FOUND')],
          [404, wire('NOT_FOUND')],
          [404, wire('NOT_FOUND')],
        ]);
        // ...and the rightful owner is not redirected away by a foreign tenant hint.
        const own = await call('GET', `/import-sessions/${session.id}?tenantId=${world.otherTenantId}`, { token: owner, headers: { 'x-tenant-id': world.otherTenantId } });
        expect(own.status).toBe(200);
        // Same-tenant OWNER-class actor with the override on: another owner's session stays hidden.
        const peerSession = await liveSession({ ownerUserId: world.users.peer.id });
        const hiddenFromOwner = await call('GET', `/import-sessions/${peerSession.id}`, { token: owner });
        expect([hiddenFromOwner.status, hiddenFromOwner.json]).toEqual([404, wire('NOT_FOUND')]);
      } finally {
        if (previous === undefined) delete process.env['ALLOW_TENANT_OVERRIDE'];
        else process.env['ALLOW_TENANT_OVERRIDE'] = previous;
      }
    });

    it('takes the tenant from the verified token, never from a header', async () => {
      const foreignSession = await liveSession({ ownerUserId: world.users.owner.id });
      const token = await tokenFor(world.users.foreign.id);
      const reply = await call('GET', `/import-sessions/${foreignSession.id}`, { token, headers: { 'x-tenant-id': world.tenantId } });
      expect(reply.status).toBe(404);
      expect(reply.json).toEqual(wire('NOT_FOUND'));
    });
  });

  describe('kill switch (default OFF)', () => {
    it('create answers 503 CAPABILITY_DISABLED and writes nothing, while GET/result/cancel keep working', async () => {
      const token = await tokenFor(world.users.owner.id);
      const create = await call('POST', '/import-sessions', { token, headers: UI, body: createBody(world.cards.pessoal) });
      expect(create.status).toBe(503);
      expect(create.json).toEqual(wire('CAPABILITY_DISABLED', { retryable: true }));
      expect(await setup.importSession.count({ where: { tenantId: world.tenantId } })).toBe(0);

      const session = await liveSession();
      const read = await call('GET', `/import-sessions/${session.id}`, { token });
      expect(read.status).toBe(200);
      expect(read.json).toMatchObject({ id: session.id, state: 'DRAFT', revision: 1 });
      expect(await call('GET', `/import-sessions/${session.id}/result`, { token })).toMatchObject({ status: 200, json: { state: 'DRAFT', receipt: null } });
      const cancel = await call('POST', `/import-sessions/${session.id}/cancel`, { token, headers: UI, body: { expectedRevision: 1 } });
      expect(cancel.status).toBe(200);
      expect(cancel.json).toMatchObject({ state: 'CANCELLED', expiresAt: null, revision: 2 });
    });

    it('keeps capabilities/session-delete routes unregistered', async () => {
      const token = await tokenFor(world.users.owner.id);
      const id = randomUUID();
      const probes: Array<[string, string]> = [
        ['GET', '/import-sessions/capabilities/x/y'],
        ['DELETE', `/import-sessions/${id}`],
      ];
      for (const [method, path] of probes) {
        const reply = await call(method, path, { token, headers: UI, body: {} });
        expect([method, path, reply.status]).toEqual([method, path, 404]);
      }
    });
  });

  describe('UI protection of the mutating routes (Origin + header + grant)', () => {
    beforeEach(() => { capability.on = true; });

    it('create needs the exact Origin and the X-RF-Import-UI header; the body flag alone is nothing', async () => {
      const token = await tokenFor(world.users.owner.id);
      const body = createBody(world.cards.pessoal);
      const attempts: Array<Record<string, string>> = [
        {},
        { origin: ORIGIN },
        { 'x-rf-import-ui': '1' },
        { origin: EVIL, 'x-rf-import-ui': '1' },
        { origin: 'null', 'x-rf-import-ui': '1' },
        { origin: '*', 'x-rf-import-ui': '1' },
        { origin: ORIGIN, 'x-rf-import-ui': '0' },
      ];
      for (const headers of attempts) {
        const reply = await call('POST', '/import-sessions', { token, headers, body });
        expect(reply.status).toBe(403);
        expect(reply.json).toEqual(wire('UI_ACTION_REQUIRED'));
      }
      expect(await setup.importSession.count({ where: { tenantId: world.tenantId } })).toBe(0);
    });

    it('a CORS-simple request (text/plain, allowed Origin, cookie) never reaches the service: zero rows', async () => {
      const cookie = await tokenFor(world.users.owner.id);
      const body = createBody(world.cards.pessoal);
      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
        const reply = await call('POST', '/import-sessions', { cookie, contentType, headers: { origin: ORIGIN }, body });
        expect([reply.status, reply.json]).toEqual([403, wire('UI_ACTION_REQUIRED')]);
      }
      const seeded = await liveSession({ ownerUserId: world.users.owner.id });
      const cancel = await call('POST', `/import-sessions/${seeded.id}/cancel`, { cookie, contentType: 'text/plain', headers: { origin: ORIGIN }, body: { expectedRevision: 1 } });
      expect([cancel.status, cancel.json]).toEqual([403, wire('UI_ACTION_REQUIRED')]);
      expect((await setup.importSession.findUniqueOrThrow({ where: { id: seeded.id } })).state).toBe('DRAFT');
      expect(await setup.importSession.count({ where: { tenantId: world.tenantId, id: { not: seeded.id } } })).toBe(0);
    });

    it('creates with 201, replays with 200, conflicts with 409, rejects extras with 400', async () => {
      const token = await tokenFor(world.users.owner.id);
      const requestId = randomUUID();
      const created = await call('POST', '/import-sessions', { token, headers: UI, body: createBody(world.cards.pessoal, requestId) });
      expect(created.status).toBe(201);
      expect(created.json).toMatchObject({ state: 'DRAFT', revision: 1, cardId: world.cards.pessoal, ownerProjectId: world.projects.pessoal, confirmation: null, receipt: null, proposal: null });
      const row = await setup.importSession.findUniqueOrThrow({ where: { id: created.json.id } });
      expect(row.draftJson).toBe(EMPTY_DRAFT_JSON);

      const replay = await call('POST', '/import-sessions', { token, headers: UI, body: createBody(world.cards.pessoal, requestId) });
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual(created.json);

      const conflict = await call('POST', '/import-sessions', { token, headers: UI, body: createBody(world.cards.casa, requestId) });
      expect([conflict.status, conflict.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);

      const extra = await call('POST', '/import-sessions', { token, headers: UI, body: { ...createBody(world.cards.pessoal), ownerProjectId: world.projects.casa } });
      expect(extra.status).toBe(400);
      expect(extra.json).toEqual(wire('INVALID_INPUT'));
      expect(await setup.importSession.count({ where: { tenantId: world.tenantId } })).toBe(1);
    });

    it('mints a grant only AFTER the body is validated (nothing is issued for a raw/invalid body)', async () => {
      const token = await tokenFor(world.users.owner.id);
      const issuer = app.get(ImportUiGrantIssuer, { strict: false });
      const spy = jest.spyOn(issuer, 'issue');
      try {
        const bodies: unknown[] = [
          { ...createBody(world.cards.pessoal), ownerProjectId: world.projects.casa },
          { ...createBody(world.cards.pessoal), consentAnalyze: false },
          { cardId: world.cards.pessoal },
          [],
        ];
        for (const body of bodies) {
          const reply = await call('POST', '/import-sessions', { token, headers: UI, body });
          expect([reply.status, reply.json.code]).toEqual([400, 'INVALID_INPUT']);
        }
        const bad = await call('POST', `/import-sessions/${randomUUID()}/cancel`, { token, headers: UI, body: { expectedRevision: 'one' } });
        expect(bad.status).toBe(400);
        expect(spy).not.toHaveBeenCalled();

        const requestId = randomUUID();
        const ok = await call('POST', '/import-sessions', { token, headers: UI, body: createBody(world.cards.pessoal, requestId) });
        expect(ok.status).toBe(201);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]![2]).toEqual({ operation: 'CREATE_SESSION', cardId: world.cards.pessoal, createRequestId: requestId, consentPolicyVersion: 1 });
      } finally {
        spy.mockRestore();
      }
    });

    it('ignores a tenant override in the query string and in headers', async () => {
      const session = await liveSession();
      const token = await tokenFor(world.users.owner.id);
      const ok = await call('GET', `/import-sessions/${session.id}?tenantId=${world.otherTenantId}&tenant=${world.otherTenantId}`, { token, headers: { 'x-tenant-id': world.otherTenantId } });
      expect(ok.status).toBe(200);
      const foreignToken = await tokenFor(world.users.foreign.id);
      const hidden = await call('GET', `/import-sessions/${session.id}?tenantId=${world.tenantId}`, { token: foreignToken, headers: { 'x-tenant-id': world.tenantId } });
      expect([hidden.status, hidden.json.code]).toEqual([404, 'NOT_FOUND']);
    });

    it('hides a card outside the ACL as an opaque 404', async () => {
      const token = await tokenFor(world.users.restricted.id);
      const reply = await call('POST', '/import-sessions', { token, headers: UI, body: createBody(world.cards.casa) });
      expect(reply.status).toBe(404);
      expect(reply.json).toEqual(wire('NOT_FOUND'));
    });

    it('cancel demands Origin + header (no financial nonce), GET does not', async () => {
      const token = await tokenFor(world.users.owner.id);
      const session = await liveSession();
      const bad: Array<Record<string, string>> = [{}, { origin: EVIL, 'x-rf-import-ui': '1' }, { origin: ORIGIN }];
      for (const headers of bad) {
        const reply = await call('POST', `/import-sessions/${session.id}/cancel`, { token, headers, body: { expectedRevision: 1 } });
        expect([reply.status, reply.json]).toEqual([403, wire('UI_ACTION_REQUIRED')]);
      }
      expect((await setup.importSession.findUniqueOrThrow({ where: { id: session.id } })).state).toBe('DRAFT');
      expect((await call('GET', `/import-sessions/${session.id}`, { token })).status).toBe(200);
      const stale = await call('POST', `/import-sessions/${session.id}/cancel`, { token, headers: UI, body: { expectedRevision: 9 } });
      expect([stale.status, stale.json]).toEqual([409, wire('REVISION_CONFLICT', { sessionId: session.id, currentRevision: 1 })]);
      const ok = await call('POST', `/import-sessions/${session.id}/cancel`, { token, headers: UI, body: { expectedRevision: 1 } });
      expect(ok.status).toBe(200);
      const again = await call('POST', `/import-sessions/${session.id}/cancel`, { token, headers: UI, body: { expectedRevision: 1 } });
      expect([again.status, again.json.state]).toEqual([200, 'CANCELLED']);
    });

    it('cancelling an APPLIED session is 409 ALREADY_APPLIED', async () => {
      const token = await tokenFor(world.users.owner.id);
      const session = await liveSession({ state: 'APPLIED', closedAt: new Date(), financialRequestId: '123e4567-e89b-42d3-a456-426614174000', confirmedRevision: 1, confirmedSessionVersion: 0, confirmedAt: new Date(), proposalHash: 'b'.repeat(64) });
      await setup.importSession.update({ where: { id: session.id }, data: { receiptJson: JSON.stringify({ version: 1, sessionId: session.id, financialRequestId: '123e4567-e89b-42d3-a456-426614174000', confirmedRevision: 1, proposalHash: 'b'.repeat(64), appliedAt: new Date().toISOString(), continuationSessionId: null, items: [] }) } });
      const reply = await call('POST', `/import-sessions/${session.id}/cancel`, { token, headers: UI, body: { expectedRevision: 1 } });
      expect([reply.status, reply.json]).toEqual([409, wire('ALREADY_APPLIED', { sessionId: session.id, currentRevision: 1 })]);
    });

    it('a preflight from a foreign origin is never authorised with that origin', async () => {
      const preflight = await call('OPTIONS', '/import-sessions', { headers: { origin: EVIL, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-rf-import-ui,content-type' } });
      expect(preflight.headers['access-control-allow-origin']).not.toBe(EVIL);
      expect(preflight.headers['access-control-allow-origin']).not.toBe('*');
    });
  });

  describe('failures', () => {
    it('logs a corrupted session with sessionId, column and error class only (secret sentinel never logged)', async () => {
      const token = await tokenFor(world.users.owner.id);
      const session = await liveSession();
      await setup.$executeRawUnsafe('UPDATE import_sessions SET draft_json = ? WHERE id = ?', '{"OCR-SENTINEL-4f9a":"private line"}', session.id);
      const spies = (['error', 'warn', 'log', 'debug', 'verbose'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
      try {
        const reply = await call('GET', `/import-sessions/${session.id}`, { token });
        expect(reply.status).toBe(500);
        const logged = spies.flatMap((spy) => spy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : String(a))).join(' '))).join('\n');
        expect(logged).not.toContain('OCR-SENTINEL-4f9a');
        expect(logged).not.toContain('private line');
        expect(logged).toContain(session.id);
        expect(logged).toContain('draft');
        expect(logged).toContain('ImportSessionCorruptStateError');
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    it('answers a generic 500 (no stored content) for a corrupted session', async () => {
      const token = await tokenFor(world.users.owner.id);
      const session = await liveSession();
      await setup.$executeRawUnsafe('UPDATE import_sessions SET draft_json = ? WHERE id = ?', '{"secret-corrupt-content":1}', session.id);
      const reply = await call('GET', `/import-sessions/${session.id}`, { token });
      expect(reply.status).toBe(500);
      expect(reply.text).not.toContain('secret-corrupt-content');
      expect(reply.json).toEqual({ statusCode: 500, message: 'Internal server error' });
    });
  });
});
