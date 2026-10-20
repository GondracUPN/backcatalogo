import 'reflect-metadata';
import * as dotenv from 'dotenv';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('pg');

// Se niega a continuar si DATABASE_URL no apunta a la base del catálogo.
// Evita aplicar migraciones del catálogo en otra base (p. ej. la de servicios).
const REQUIRED_TABLES = ['products', 'staged_products', 'catalog_public', 'User'];

async function main() {
  dotenv.config();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL no está configurado');
  const client = new Client({ connectionString: url, ssl: url.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    const rows = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES],
    );
    const found = new Set(rows.rows.map((row: any) => row.table_name));
    const missing = REQUIRED_TABLES.filter((name) => !found.has(name));
    if (missing.length) {
      console.error(`[db:check] Esta base NO es la del catálogo. Faltan: ${missing.join(', ')}`);
      process.exit(2);
    }
    const migrations = await client.query(`SELECT name FROM migrations ORDER BY id`).catch(() => ({ rows: [] as any[] }));
    console.log(`[db:check] OK: base del catálogo. Migraciones registradas: ${migrations.rows.length}`);
    for (const row of migrations.rows) console.log(`  - ${row.name}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[db:check] Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
