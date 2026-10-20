import 'reflect-metadata';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { HttpException } from '@nestjs/common';
import { isolatedDatabaseUrl } from '../utils/test-database';
import { consumeLoginAttempt } from '../utils/login-attempts';
import { AuthService } from '../modules/auth/auth.service';
import { User } from '../entities/user.entity';
import { SalesSyncService } from '../modules/catalog-admin/sales-sync.service';
import { LoginAttempts1792400000000 } from '../migrations/1792400000000-LoginAttempts';

async function main() {
  // Solo puede abrir la base ficticia local. No carga .env ni AppModule.
  const db = new DataSource({ type: 'postgres', url: isolatedDatabaseUrl(process.env.MACSO_TEST_DATABASE_URL), entities: [User] });
  await db.initialize();
  try {
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const migration = new LoginAttempts1792400000000();
      await migration.down(runner);
      const [missing] = await runner.query(`SELECT to_regclass('public.auth_login_attempts') AS table_name`);
      assert.equal(missing.table_name, null);
      await migration.up(runner);
      const [present] = await runner.query(`SELECT to_regclass('public.auth_login_attempts') AS table_name`);
      assert.equal(present.table_name, 'auth_login_attempts');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    await db.query('DELETE FROM auth_login_attempts');
    const auth = new AuthService(db.getRepository(User));
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => auth.validateUser('unknown_t', 'invalid-password', '192.0.2.1'),
        (e: unknown) => e instanceof HttpException && e.getStatus() === 401);
    }
    await assert.rejects(() => auth.validateUser('unknown_t', 'invalid-password', '192.0.2.1'),
      (e: unknown) => e instanceof HttpException && e.getStatus() === 429);
    // El bloqueo por cuenta se mantiene al cambiar de IP.
    await assert.rejects(() => consumeLoginAttempt(db.manager, 'unknown_t', '192.0.2.2'),
      (e: unknown) => e instanceof HttpException && e.getStatus() === 429);
    // El bloqueo por IP se mantiene al cambiar de cuenta.
    await assert.rejects(() => consumeLoginAttempt(db.manager, 'different_t', '192.0.2.1'),
      (e: unknown) => e instanceof HttpException && e.getStatus() === 429);
    await db.query(`UPDATE auth_login_attempts SET expires_at = now() - interval '1 second'`);
    await consumeLoginAttempt(db.manager, 'unknown_t', '192.0.2.1');
    await db.query('DELETE FROM auth_login_attempts');
    // Simula dos o más instancias compartiendo PostgreSQL bajo concurrencia.
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => consumeLoginAttempt(db.manager, 'concurrent_t', '192.0.2.3')));
    assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 5);
    assert.equal(attempts.filter((r) => r.status === 'rejected' && r.reason.getStatus() === 429).length, 7);
    await db.query('DELETE FROM auth_login_attempts');
    const user = await auth.validateUser('admin_t', process.env.MACSO_TEST_PASSWORD || '', '192.0.2.4');
    assert.equal(user.role, 'ADMIN');

    const service = new SalesSyncService(db);
    await service.ensureTable();
    const eventId = 'aaaaaaaa-1111-4111-8111-111111111111';
    await db.query(`INSERT INTO sale_sync_events (id, sale_id, event_type, payload)
      VALUES ($1, $1, 'sale.created', '{}') ON CONFLICT (id) DO UPDATE SET remote_status = NULL`, [eventId]);
    assert.deepEqual(await service.updateRemoteStatus(eventId, 'confirmed'), { ok: true, status: 'confirmed' });
    const [first] = await db.query('SELECT updated_at FROM sale_sync_events WHERE id = $1', [eventId]);
    await service.updateRemoteStatus(eventId, 'confirmed');
    const [replay] = await db.query('SELECT updated_at FROM sale_sync_events WHERE id = $1', [eventId]);
    assert.equal(first.updated_at.getTime(), replay.updated_at.getTime(), 'repetición idempotente');
    await assert.rejects(() => service.updateRemoteStatus(eventId, 'pending_confirmation'),
      (e: unknown) => e instanceof HttpException && e.getStatus() === 409);
    await assert.rejects(() => service.updateRemoteStatus(eventId, 'cancelled'),
      (e: unknown) => e instanceof HttpException && e.getStatus() === 409);
    await assert.rejects(() => service.updateRemoteStatus(eventId, 'invalid'),
      (e: unknown) => e instanceof HttpException && e.getStatus() === 400);
    await assert.rejects(() => service.updateRemoteStatus('bbbbbbbb-1111-4111-8111-111111111111', 'confirmed'),
      (e: unknown) => e instanceof HttpException && e.getStatus() === 404);
    await db.query('DELETE FROM sale_sync_events WHERE id = $1', [eventId]);
    await db.query('DELETE FROM auth_login_attempts');
    console.log('security-postgres: login, expiry, concurrency and webhook replay checks passed');
  } finally { await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
