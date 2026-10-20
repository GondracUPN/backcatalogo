/** Nunca acepta una URL de producción como destino de las pruebas de escritura. */
export function isolatedDatabaseUrl(raw: string | undefined) {
  if (!raw) throw new Error('MACSO_TEST_DATABASE_URL is required');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/macsomenos_test'
    || url.username !== 'macso_test') {
    throw new Error('Tests require local macso_test@macsomenos_test');
  }
  return url.toString();
}
