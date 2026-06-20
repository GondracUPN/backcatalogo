import { MigrationInterface, QueryRunner } from "typeorm";

export class CatalogReadIndexes1737000000000 implements MigrationInterface {
  name = "CatalogReadIndexes1737000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS catalog_public_published_category_order_idx ON catalog_public (is_published, category, sort_order, created_at DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS products_title_idx ON products (title)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS staged_products_title_idx ON staged_products (title)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS staged_products_sku_idx ON staged_products (sku)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS staged_products_sku_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS staged_products_title_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS products_title_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS catalog_public_published_category_order_idx`);
  }
}
