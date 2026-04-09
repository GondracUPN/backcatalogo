import 'reflect-metadata';
import * as dotenv from 'dotenv';
import AppDataSource from './data-source';
import { User } from './entities/user.entity';
import * as bcrypt from 'bcryptjs';

dotenv.config();

async function run() {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(User);
  const username = String(process.env.ADMIN_BOOTSTRAP_USERNAME || '').trim();
  const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '').trim();

  if (!username || !password) {
    // eslint-disable-next-line no-console
    console.log('Seed: skipping admin bootstrap. Set ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD to create one.');
    await AppDataSource.destroy();
    return;
  }

  const exists = await repo.findOne({ where: { username } });
  if (!exists) {
    const passwordHash = await bcrypt.hash(password, 10);
    await repo.save(repo.create({ username, passwordHash, role: 'ADMIN' }));
    // eslint-disable-next-line no-console
    console.log(`Seed: admin user created (${username})`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`Seed: admin already exists (${username})`);
  }
  await AppDataSource.destroy();
}

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
