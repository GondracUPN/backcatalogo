import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductCondition1734000000000 implements MigrationInterface {
  name = 'ProductCondition1734000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS product_condition text NULL`);
    await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS product_condition text NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS product_condition`);
    await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS product_condition`);
  }
}
