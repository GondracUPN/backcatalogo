import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { HttpException, HttpStatus } from '@nestjs/common';
import { EntityManager } from 'typeorm';

const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 5;
export function loginBucket(kind: 'account' | 'ip', value: string) {
  return createHash('sha256').update(`${kind}:${value}`).digest('hex');
}

type LoginRequest = {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
};

function header(req: LoginRequest, name: string) {
  const value = req.headers?.[name];
  return String(Array.isArray(value) ? value[0] : value || '').trim();
}

/**
 * IP del cliente para el contador de intentos. El login del panel llega a través
 * de Next: sin esto todo el personal compartiría la IP del servidor de Next y cinco
 * fallos de cualquiera bloquearían a todos. Solo se acepta la IP reenviada cuando
 * viene con LOGIN_PROXY_SECRET; nunca se confía en cabeceras enviadas por el cliente.
 */
export function loginClientIp(req: LoginRequest | undefined) {
  const socketIp = req?.ip || req?.socket?.remoteAddress || 'unknown';
  const expected = String(process.env.LOGIN_PROXY_SECRET || '').trim();
  const provided = req ? header(req, 'x-login-proxy-secret') : '';
  if (!expected || !provided) return socketIp;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return socketIp;
  const forwarded = header(req!, 'x-login-client-ip');
  return isIP(forwarded) ? forwarded : socketIp;
}

/** Reservas atómicas compartidas por todas las instancias; sin DDL en peticiones. */
export async function consumeLoginAttempt(manager: EntityManager, username: string, ip: string) {
  const keys = [loginBucket('account', username.toLowerCase()), loginBucket('ip', ip)].sort();
  await manager.transaction(async (tx) => {
    for (const key of keys) {
      const rows = await tx.query(
        `INSERT INTO auth_login_attempts (key, attempts, expires_at)
         VALUES ($1, 1, now() + $2 * interval '1 millisecond')
         ON CONFLICT (key) DO UPDATE
         SET attempts = CASE WHEN auth_login_attempts.expires_at <= now() THEN 1 ELSE auth_login_attempts.attempts + 1 END,
             expires_at = CASE WHEN auth_login_attempts.expires_at <= now() THEN EXCLUDED.expires_at ELSE auth_login_attempts.expires_at END
         RETURNING attempts`, [key, WINDOW_MS],
      );
      if (Number(rows[0].attempts) > LIMIT) {
        // La transacción revierte el incremento; el bloqueo no extiende su ventana.
        throw new HttpException('Demasiados intentos. Inténtalo de nuevo en 10 minutos.', HttpStatus.TOO_MANY_REQUESTS);
      }
    }
    await tx.query(`DELETE FROM auth_login_attempts WHERE key IN (
      SELECT key FROM auth_login_attempts WHERE expires_at <= now() LIMIT 100
    )`);
  });
}
