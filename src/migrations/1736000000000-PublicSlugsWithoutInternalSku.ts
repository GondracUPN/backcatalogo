import { MigrationInterface, QueryRunner } from 'typeorm';

function slugify(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

type PublicSlugRow = {
  id: string;
  slug: string;
  title: string | null;
  created_at: Date | string;
};

export class PublicSlugsWithoutInternalSku1736000000000 implements MigrationInterface {
  name = 'PublicSlugsWithoutInternalSku1736000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = await queryRunner.query(`
      SELECT cp.id, cp.slug, p.title, cp.created_at
      FROM catalog_public cp
      LEFT JOIN products p ON p.id = cp.product_id
      ORDER BY cp.created_at ASC, cp.id ASC
    `) as PublicSlugRow[];

    if (!rows.length) return;

    const used = new Set<string>();
    const replacements = rows.map((row) => {
      const cleanCurrent = String(row.slug || '').replace(/-svc-\d+$/i, '');
      const base = slugify(row.title || cleanCurrent) || 'producto';
      let next = base;
      let suffix = 1;
      while (used.has(next)) {
        suffix += 1;
        next = `${base}-${suffix}`;
      }
      used.add(next);
      return { id: row.id, slug: next };
    });

    for (const row of replacements) {
      await queryRunner.query(
        `UPDATE catalog_public SET slug = $1, updated_at = now() WHERE id = $2`,
        [`slug-migration-${row.id}`, row.id],
      );
    }
    for (const row of replacements) {
      await queryRunner.query(
        `UPDATE catalog_public SET slug = $1, updated_at = now() WHERE id = $2`,
        [row.slug, row.id],
      );
    }
  }

  public async down(): Promise<void> {
    // Los slugs con SKU interno no se restauran deliberadamente.
  }
}
