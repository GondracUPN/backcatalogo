import { MigrationInterface, QueryRunner } from 'typeorm';

export class SellerSalesAnalytics1792454500000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `CREATE INDEX IF NOT EXISTS idx_staged_owner_status_created ON staged_products(owner_user_id,status,created_at)`,
    );
    await runner.query(
      `CREATE INDEX IF NOT EXISTS idx_staged_owner_sku ON staged_products(owner_user_id,sku)`,
    );
    await runner.query(`DO $$ BEGIN
      IF to_regclass('public.sold_records') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_sales_owner_sold ON sold_records(owner_user_id,sold_at);
        CREATE INDEX IF NOT EXISTS idx_sales_sku_date ON sold_records(sku,sold_at);
      END IF;
    END $$`);
    // La fecha de primera publicación no se infiere de created_at o updated_at.
    await runner.query(
      `ALTER TABLE catalog_public ADD COLUMN IF NOT EXISTS first_published_at timestamptz`,
    );
    await runner.query(`CREATE FUNCTION remember_first_publication() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.is_published AND NEW.first_published_at IS NULL AND (TG_OP='INSERT' OR OLD.is_published IS DISTINCT FROM true) THEN NEW.first_published_at:=now(); END IF;
        RETURN NEW;
      END $$`);
    await runner.query(
      `CREATE TRIGGER catalog_first_publication BEFORE INSERT OR UPDATE OF is_published ON catalog_public FOR EACH ROW EXECUTE FUNCTION remember_first_publication()`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP TRIGGER catalog_first_publication ON catalog_public',
    );
    await runner.query('DROP FUNCTION remember_first_publication()');
    await runner.query(
      'ALTER TABLE catalog_public DROP COLUMN first_published_at',
    );
    for (const index of [
      'idx_staged_owner_status_created',
      'idx_staged_owner_sku',
      'idx_sales_owner_sold',
      'idx_sales_sku_date',
    ]) {
      await runner.query(`DROP INDEX IF EXISTS ${index}`);
    }
  }
}
