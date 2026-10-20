import 'reflect-metadata';
import { isolatedDatabaseUrl } from '../utils/test-database';
import { DataSource } from 'typeorm';
import { User } from '../entities/user.entity';
import * as bcrypt from 'bcryptjs';

async function main() {
  process.env.DATABASE_URL = isolatedDatabaseUrl(process.env.MACSO_TEST_DATABASE_URL);
  const password = process.env.MACSO_TEST_PASSWORD;
  if (!password || password.length < 12) throw new Error('MACSO_TEST_PASSWORD must have at least 12 characters');
  const db: DataSource = require('../data-source').default;
  await db.initialize();
  try {
    const applied = await db.runMigrations({ transaction: 'each' });
    const users = db.getRepository(User);
    for (const [username, role, canViewServiceInventory] of [
      ['admin_t', 'ADMIN', false], ['vend_flag_t', 'VENDEDOR', true], ['vend_indep_t', 'VENDEDOR', false],
    ] as const) {
      if (!await users.findOneBy({ username })) {
        await users.save(users.create({ username, role, canViewServiceInventory, passwordHash: await bcrypt.hash(password, 10) }));
      }
    }
    console.log(`Isolated database ready; ${applied.length} migrations applied; 3 fictitious users available.`);
  } finally { await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
