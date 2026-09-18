import { MigrationInterface, QueryRunner } from 'typeorm';

export class SellerInventoryAccess1741000000000 implements MigrationInterface {
  name = 'SellerInventoryAccess1741000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "can_view_service_inventory" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS owner_user_id integer NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_staged_products_owner_user_id ON staged_products(owner_user_id)`);
    await queryRunner.query(`ALTER TABLE IF EXISTS sold_records ADD COLUMN IF NOT EXISTS owner_user_id integer NULL`);
    await queryRunner.query(`ALTER TABLE IF EXISTS contact_requests ADD COLUMN IF NOT EXISTS owner_user_id integer NULL`);
    await queryRunner.query(`ALTER TABLE IF EXISTS possible_clients ADD COLUMN IF NOT EXISTS owner_user_id integer NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_staged_products_owner_user_id`);
    await queryRunner.query(`ALTER TABLE IF EXISTS possible_clients DROP COLUMN IF EXISTS owner_user_id`);
    await queryRunner.query(`ALTER TABLE IF EXISTS contact_requests DROP COLUMN IF EXISTS owner_user_id`);
    await queryRunner.query(`ALTER TABLE IF EXISTS sold_records DROP COLUMN IF EXISTS owner_user_id`);
    await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS owner_user_id`);
    await queryRunner.query(`ALTER TABLE "User" DROP COLUMN IF EXISTS "can_view_service_inventory"`);
  }
}
