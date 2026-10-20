import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  ProductPhotosService,
  imageUrl,
} from '../modules/catalog-admin/product-photos.service';

export async function auditPhotoUrls(database: Pick<DataSource, 'query'>) {
  const policy = new ProductPhotosService(database as DataSource);
  const counts: Record<string, { total: number; unsupported: number }> = {};
  for (const table of ['staged_products', 'catalog_public']) {
    const rows: Array<{ images: unknown[] | null }> = await database.query(
      `SELECT images FROM ${table}`,
    );
    const urls = rows
      .flatMap((row) => row.images || [])
      .map(imageUrl)
      .filter(Boolean);
    counts[table] = {
      total: urls.length,
      unsupported: urls.filter((url) => !policy.allowedUrl(url)).length,
    };
  }
  return counts;
}

async function main() {
  const database = require('../data-source').default as DataSource;
  await database.initialize();
  const runner = database.createQueryRunner();
  try {
    await runner.connect();
    await runner.query('BEGIN READ ONLY');
    console.log(
      JSON.stringify(
        await auditPhotoUrls(runner as unknown as DataSource),
        null,
        2,
      ),
    );
    await runner.query('ROLLBACK');
  } finally {
    await runner.release();
    await database.destroy();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
