import 'reflect-metadata';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { SyncController } from '../modules/sync/sync.controller';
import { AdminController } from '../modules/catalog-admin/admin.controller';
import { requireRole } from '../utils/staff-auth';
import { isolatedDatabaseUrl } from '../utils/test-database';
import { databaseUrl } from '../utils/database-url';
import { loginClientIp } from '../utils/login-attempts';

async function status(action: () => unknown, expected: number) {
  await assert.rejects(async () => action(), (e: unknown) => e instanceof HttpException && e.getStatus() === expected);
}

async function main() {
  const before = { ...process.env };
  try {
    assert.throws(() => isolatedDatabaseUrl('postgres://macso_test@remote.example/macsomenos_test'));
    assert.throws(() => isolatedDatabaseUrl('postgres://macso_test@localhost/production'));
    process.env.NODE_ENV = 'development';
    delete process.env.MACSO_TEST_DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://user@remote.example/production';
    assert.throws(() => databaseUrl(), /Remote database blocked/);
    process.env.ALLOWED_REMOTE_DATABASE_HOST = 'dev.example';
    assert.throws(() => databaseUrl(), /Remote database blocked/);
    process.env.DATABASE_URL = 'postgres://user@DEV.example/dev';
    assert.equal(databaseUrl(), 'postgres://user@DEV.example/dev');
    delete process.env.ALLOWED_REMOTE_DATABASE_HOST;
    let touched = 0;
    const repo = new Proxy({}, { get() { touched++; throw new Error('unauthorized DB access'); } }) as any;
    const sync = new SyncController(repo, repo, repo, repo);
    const eventId = '11111111-1111-4111-8111-111111111111';
    let calls = 0;
    const admin = new AdminController({ verifyToken() { throw new Error('bad JWT'); } } as any,
      repo, repo, repo, repo, {} as any, { updateRemoteStatus: async () => { calls++; return { ok: true }; } } as any);
    for (const env of ['development', 'production']) {
      process.env.NODE_ENV = env;
      delete process.env.CATALOG_SYNC_SECRET;
      process.env.CATALOG_SYNC_REQUIRE_SECRET = '0';
      await status(() => sync.exists('MS-1'), 503);
      await status(() => sync.syncProduct('id-1', {}), 503);
      await status(() => admin.updateSaleSyncRemoteStatus(eventId, { status: 'confirmed' }), 503);
      process.env.CATALOG_SYNC_SECRET = 'test-secret';
      for (const secret of [undefined, 'wrong']) {
        await status(() => sync.exists('MS-1', undefined, secret), 401);
        await status(() => sync.syncProduct('id-1', {}, secret), 401);
        await status(() => admin.updateSaleSyncRemoteStatus(eventId, { status: 'confirmed' }, secret), 401);
      }
      assert.deepEqual(await sync.exists(undefined, undefined, 'test-secret'), { exists: false });
      assert.deepEqual(await sync.exists(undefined, undefined, undefined, 'Bearer test-secret'), { exists: false });
      await status(() => sync.exists('MS-1', undefined, undefined, 'test-secret'), 401);
      assert.deepEqual(await admin.updateSaleSyncRemoteStatus(eventId, { status: 'confirmed' }, 'test-secret'), { ok: true });
      await status(() => admin.updateSaleSyncRemoteStatus('malformed', { status: 'confirmed' }, 'test-secret'), 400);
      await status(() => admin.updateSaleSyncRemoteStatus(eventId, { status: {} }, 'test-secret'), 400);
    }
    assert.equal(touched, 0);
    assert.equal(calls, 2);
    for (const action of [
      () => admin.listStaged('Bearer abc.def.ghi'), () => admin.listSales('Bearer abc.def.ghi'),
      () => admin.listContactRequests('Bearer abc.def.ghi'), () => admin.listPossibleClients('Bearer abc.def.ghi'),
    ]) await status(action, 401);
    await status(() => requireRole({ verifyToken: () => ({ role: 'CLIENTE' }) } as any, 'Bearer test', ['ADMIN', 'VENDEDOR']), 403);
    const seller = new AdminController({ verifyToken: () => ({ sub: 7, role: 'VENDEDOR' }) } as any,
      repo, repo, repo, repo, {} as any, {} as any);
    for (const statusValue of ['sold', 'published', 'hidden', 'arbitrary']) {
      await status(() => seller.updateStaged('Bearer test', 'test-id', { status: statusValue }), 400);
    }
    assert.equal(touched, 0);
    // IP del cliente para el límite de login: solo se acepta la reenviada por Next con secreto.
    const viaNext = (secret?: string, ip = '203.0.113.7') => ({
      ip: '10.0.0.1', headers: { 'x-login-proxy-secret': secret, 'x-login-client-ip': ip },
    });
    delete process.env.LOGIN_PROXY_SECRET;
    assert.equal(loginClientIp(viaNext('proxy-secret')), '10.0.0.1');
    process.env.LOGIN_PROXY_SECRET = 'proxy-secret';
    assert.equal(loginClientIp(viaNext('proxy-secret')), '203.0.113.7');
    assert.equal(loginClientIp(viaNext('proxy-secret', '2001:db8::1')), '2001:db8::1');
    assert.equal(loginClientIp(viaNext('wrong')), '10.0.0.1');
    assert.equal(loginClientIp(viaNext(undefined)), '10.0.0.1');
    assert.equal(loginClientIp(viaNext('proxy-secret', 'not-an-ip')), '10.0.0.1');
    assert.equal(loginClientIp({ socket: { remoteAddress: '10.0.0.2' } }), '10.0.0.2');
    assert.equal(loginClientIp(undefined), 'unknown');
    console.log('security-phase1: secrets, DB isolation and malformed JWT checks passed');
  } finally { process.env = before; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
