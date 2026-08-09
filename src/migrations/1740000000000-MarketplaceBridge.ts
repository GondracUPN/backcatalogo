import { MigrationInterface, QueryRunner } from 'typeorm';

export class MarketplaceBridge1740000000000 implements MigrationInterface {
  name = 'MarketplaceBridge1740000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS marketplace_bridge_items (
        token uuid PRIMARY KEY,
        payload jsonb NOT NULL,
        created_by integer NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_marketplace_bridge_expires_at
      ON marketplace_bridge_items (expires_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS marketplace_bridge_items`);
  }
}
