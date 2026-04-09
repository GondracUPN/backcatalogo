import { MigrationInterface, QueryRunner } from "typeorm";

export class CatalogSync1730000001000 implements MigrationInterface {
    name = 'CatalogSync1730000001000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS products (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            sku text UNIQUE NOT NULL,
            title text NOT NULL,
            price numeric(12,2) NOT NULL DEFAULT 0,
            status text NOT NULL DEFAULT 'draft',
            stock int NOT NULL DEFAULT 0,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        )`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS sync_logs (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            idem_key text UNIQUE NOT NULL,
            received_at timestamptz NOT NULL DEFAULT now()
        )`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS staged_products (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            source_id uuid UNIQUE NOT NULL,
            sku text NOT NULL,
            title text NOT NULL,
            price numeric(12,2) NOT NULL DEFAULT 0,
            stock int NOT NULL DEFAULT 0,
            status text NOT NULL DEFAULT 'draft',
            category text NULL,
            tags text[] NULL,
            images jsonb NOT NULL DEFAULT '[]',
            notes text NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        )`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS catalog_public (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            product_id uuid UNIQUE NOT NULL,
            slug text UNIQUE NOT NULL,
            sort_order int NOT NULL DEFAULT 0,
            is_published boolean NOT NULL DEFAULT false,
            category text NULL,
            tags text[] NULL,
            images jsonb NULL,
            seo_title text NULL,
            seo_desc text NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        )`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS orders (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            product_id uuid NOT NULL,
            qty int NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS orders`);
        await queryRunner.query(`DROP TABLE IF EXISTS catalog_public`);
        await queryRunner.query(`DROP TABLE IF EXISTS staged_products`);
        await queryRunner.query(`DROP TABLE IF EXISTS sync_logs`);
        await queryRunner.query(`DROP TABLE IF EXISTS products`);
    }
}

