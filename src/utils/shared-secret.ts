import { timingSafeEqual } from 'node:crypto';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Valida el secreto compartido de las integraciones servidor a servidor.
 *
 * - Con CATALOG_SYNC_SECRET definido, se exige `x-sync-secret` (o `Authorization: Bearer`).
 * - Sin secreto definido nunca se acepta la petición, en ningún entorno.
 */
export function isValidSyncSecret(headers: { secret?: string; authorization?: string }) {
  const expected = String(process.env.CATALOG_SYNC_SECRET || '').trim();
  if (!expected) return false;
  const bearer = /^Bearer\s+(.+)$/i.exec(String(headers.authorization || ''))?.[1]?.trim() || '';
  const provided = String(headers.secret || '').trim() || bearer;
  return Boolean(provided) && safeEqual(provided, expected);
}

export function requireSyncSecret(headers: { secret?: string; authorization?: string }) {
  if (!String(process.env.CATALOG_SYNC_SECRET || '').trim()) {
    throw new ServiceUnavailableException('Sync authentication is not configured');
  }
  if (!isValidSyncSecret(headers)) throw new UnauthorizedException('Invalid sync credentials');
}
