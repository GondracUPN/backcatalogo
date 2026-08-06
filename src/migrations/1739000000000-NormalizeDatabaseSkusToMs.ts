import { MigrationInterface, QueryRunner } from 'typeorm';

function normalizeSku(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/^prev[-_\s]*svc(?=[-_\s]*\d)/i, 'PREV-MS')
    .replace(/^svc(?=[-_\s]*\d)/i, 'MS')
    .toUpperCase();
}

function normalizeNoteSkuReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNoteSkuReferences);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, any>).map(([key, child]) => {
      if (/sku$/i.test(key) && typeof child === 'string') return [key, normalizeSku(child)];
      if (/skus$/i.test(key) && Array.isArray(child)) return [key, child.map(normalizeSku)];
      return [key, normalizeNoteSkuReferences(child)];
    }),
  );
}

export class NormalizeDatabaseSkusToMs1739000000000 implements MigrationInterface {
  name = 'NormalizeDatabaseSkusToMs1739000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE products
      SET sku = regexp_replace(
        regexp_replace(upper(trim(sku)), '^PREV[-_ ]*SVC(?=[-_ ]*[0-9])', 'PREV-MS'),
        '^SVC(?=[-_ ]*[0-9])',
        'MS'
      )
      WHERE sku ~* '^(PREV[-_ ]*)?SVC[-_ ]*[0-9]'
    `);
    await queryRunner.query(`
      UPDATE staged_products
      SET sku = regexp_replace(
        regexp_replace(upper(trim(sku)), '^PREV[-_ ]*SVC(?=[-_ ]*[0-9])', 'PREV-MS'),
        '^SVC(?=[-_ ]*[0-9])',
        'MS'
      )
      WHERE sku ~* '^(PREV[-_ ]*)?SVC[-_ ]*[0-9]'
    `);
    const soldRecordsTable = await queryRunner.hasTable('sold_records');
    if (soldRecordsTable) {
      await queryRunner.query(`
        UPDATE sold_records
        SET sku = regexp_replace(
          regexp_replace(upper(trim(sku)), '^PREV[-_ ]*SVC(?=[-_ ]*[0-9])', 'PREV-MS'),
          '^SVC(?=[-_ ]*[0-9])',
          'MS'
        )
        WHERE sku ~* '^(PREV[-_ ]*)?SVC[-_ ]*[0-9]'
      `);
    }

    const rows: Array<{ id: string; notes: string | null }> = await queryRunner.query(
      `SELECT id, notes FROM staged_products WHERE notes IS NOT NULL`,
    );
    for (const row of rows) {
      try {
        const current = JSON.parse(row.notes || '{}');
        const normalized = normalizeNoteSkuReferences(current);
        const next = JSON.stringify(normalized);
        if (next !== JSON.stringify(current)) {
          await queryRunner.query(`UPDATE staged_products SET notes = $1 WHERE id = $2`, [next, row.id]);
        }
      } catch {
        // Preserve legacy free-text notes that are not JSON.
      }
    }
  }

  async down(): Promise<void> {
    // The MS prefix is the canonical public identifier and should not be reverted.
  }
}
