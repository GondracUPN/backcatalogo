import { isolatedDatabaseUrl } from './test-database';

export function databaseUrl() {
  if (process.env.MACSO_TEST_DATABASE_URL) {
    const url = isolatedDatabaseUrl(process.env.MACSO_TEST_DATABASE_URL);
    process.env.UPSTREAM_SYNC_ON_READ = '0';
    process.env.UPSTREAM_API_BASE = '';
    process.env.SERVICES_API_BASE = '';
    process.env.SERVICES_SALES_SYNC_URL = '';
    process.env.NEXT_BASE_URL = '';
    return url;
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required');
  const url = new URL(raw);
  // Fuera de producción solo se acepta una base remota si su host se autoriza
  // expresamente (p. ej. la rama de desarrollo de Neon). Atado al host: si alguien
  // pega otra URL (la de producción), vuelve a bloquearse.
  const allowedRemoteHost = String(process.env.ALLOWED_REMOTE_DATABASE_HOST || '').trim().toLowerCase();
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (process.env.NODE_ENV !== 'production' && !isLocal && url.hostname.toLowerCase() !== allowedRemoteHost) {
    throw new Error(
      'Remote database blocked outside production. If this is a development database, set ALLOWED_REMOTE_DATABASE_HOST to its host; for local tests use MACSO_TEST_DATABASE_URL.',
    );
  }
  return raw;
}
