import { MigrationInterface, QueryRunner } from "typeorm";

export class ProductVariants1734000000000 implements MigrationInterface {
  name = "ProductVariants1734000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_group text NULL`);
    await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS variant_group text NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS products_variant_group_idx ON products (variant_group)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS staged_products_variant_group_idx ON staged_products (variant_group)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS staged_products_variant_group_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS products_variant_group_idx`);
    await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS variant_group`);
    await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS variant_group`);
  }
}
