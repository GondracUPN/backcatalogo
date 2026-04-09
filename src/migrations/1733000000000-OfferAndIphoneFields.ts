import { MigrationInterface, QueryRunner } from "typeorm";

export class OfferAndIphoneFields1733000000000 implements MigrationInterface {
    name = 'OfferAndIphoneFields1733000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS iphone_number int NULL`);
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS storage_gb int NULL`);
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS battery_cycles int NULL`);
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS battery_health int NULL`);
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color text NULL`);

        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS iphone_number int NULL`);
        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS storage_gb int NULL`);
        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS battery_cycles int NULL`);
        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS battery_health int NULL`);
        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS color text NULL`);

        await queryRunner.query(`CREATE TABLE IF NOT EXISTS offer_attempts (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            product_id uuid NOT NULL,
            cart_id uuid NULL,
            fingerprint text NOT NULL,
            attempts int NOT NULL DEFAULT 0,
            blocked boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        )`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS offer_attempts_product_fingerprint_idx ON offer_attempts (product_id, fingerprint)`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS offer_attempts_product_cart_idx ON offer_attempts (product_id, cart_id) WHERE cart_id IS NOT NULL`);

        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS cart_items_cart_product_idx ON cart_items (cart_id, product_id)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS cart_items_cart_product_idx`);

        await queryRunner.query(`DROP INDEX IF EXISTS offer_attempts_product_cart_idx`);
        await queryRunner.query(`DROP INDEX IF EXISTS offer_attempts_product_fingerprint_idx`);
        await queryRunner.query(`DROP TABLE IF EXISTS offer_attempts`);

        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS color`);
        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS battery_health`);
        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS battery_cycles`);
        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS storage_gb`);
        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS iphone_number`);

        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS color`);
        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS battery_health`);
        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS battery_cycles`);
        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS storage_gb`);
        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS iphone_number`);
    }
}
