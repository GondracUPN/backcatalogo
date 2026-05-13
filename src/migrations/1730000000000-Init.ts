import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1730000000000 implements MigrationInterface {
    name = 'Init1730000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Asegurar enum Role idempotente sin borrar un tipo que ya esta en uso.
        await queryRunner.query(`DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Role') THEN
    CREATE TYPE "Role" AS ENUM ('ADMIN', 'VENDEDOR', 'CLIENTE');
  END IF;
END$$;`);
        await queryRunner.query(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ADMIN'`);
        await queryRunner.query(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'VENDEDOR'`);
        await queryRunner.query(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'CLIENTE'`);
        // Tablas con IF NOT EXISTS para evitar fallos si existen
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "User" (
            "id" SERIAL NOT NULL,
            "username" TEXT NOT NULL,
            "passwordHash" TEXT NOT NULL,
            "role" "Role" NOT NULL DEFAULT 'CLIENTE',
            "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
            CONSTRAINT "User_pkey" PRIMARY KEY ("id")
        )`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User" ("username")`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "Producto" (
            "id" SERIAL NOT NULL,
            "tipo" TEXT NOT NULL,
            "estado" TEXT NOT NULL,
            "conCaja" BOOLEAN NOT NULL DEFAULT false,
            "casillero" TEXT,
            "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
            "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
            CONSTRAINT "Producto_pkey" PRIMARY KEY ("id")
        )`);
        await queryRunner.query(`CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`);
        await queryRunner.query(`DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_set_updated_at') THEN
    CREATE TRIGGER trigger_set_updated_at
BEFORE UPDATE ON "Producto"
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
  END IF;
END$$;`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS trigger_set_updated_at ON "Producto"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS set_updated_at`);
        await queryRunner.query(`DROP TABLE "Producto"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "User_username_key"`);
        await queryRunner.query(`DROP TABLE "User"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "Role"`);
    }

}
