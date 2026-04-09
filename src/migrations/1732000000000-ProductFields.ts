import { MigrationInterface, QueryRunner } from "typeorm";

export class ProductFields1732000000000 implements MigrationInterface {
    name = 'ProductFields1732000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS iphone_model text NULL`);
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS includes text NULL`);
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS includes_extra text NULL`);
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS keyboard_layout text NULL`);
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_type text NULL`);
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS discount numeric(12,2) NULL`);
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS final_price numeric(12,2) NULL`);
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS min_offer_price numeric(12,2) NULL`);
        await queryRunner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cart_id uuid NULL`);

        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS iphone_model text NULL`);
        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS includes text NULL`);
        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS includes_extra text NULL`);
        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS keyboard_layout text NULL`);
        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS sale_type text NULL`);
        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS discount numeric(12,2) NULL`);
        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS final_price numeric(12,2) NULL`);
        await queryRunner.query(`ALTER TABLE staged_products ADD COLUMN IF NOT EXISTS min_offer_price numeric(12,2) NULL`);

        await queryRunner.query(`CREATE TABLE IF NOT EXISTS cart_items (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            cart_id uuid NOT NULL,
            product_id uuid NOT NULL,
            qty int NOT NULL DEFAULT 1,
            offer_price numeric(12,2) NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        )`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS cart_items`);

        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS min_offer_price`);
        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS final_price`);
        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS discount`);
        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS sale_type`);
        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS keyboard_layout`);
        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS includes_extra`);
        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS includes`);
        await queryRunner.query(`ALTER TABLE staged_products DROP COLUMN IF EXISTS iphone_model`);

        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS cart_id`);
        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS min_offer_price`);
        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS final_price`);
        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS discount`);
        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS sale_type`);
        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS keyboard_layout`);
        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS includes_extra`);
        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS includes`);
        await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS iphone_model`);
    }
}
