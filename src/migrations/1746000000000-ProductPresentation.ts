import { MigrationInterface, QueryRunner } from 'typeorm';

// Aditiva: presentación de la unidad (sellado/abierto), independiente de la
// condición (Nuevo, Open Box, Usado). NULL = no especificado: los registros
// existentes quedan así; no se marca ningún producto como sellado por ser Nuevo.
// La sincronización de inventario no escribe esta columna, así que se conserva.
export class ProductPresentation1746000000000 implements MigrationInterface {
  name = 'ProductPresentation1746000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['products', 'staged_products']) {
      await queryRunner.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS presentation text NULL`);
      await queryRunner.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_presentation_check`);
      await queryRunner.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_presentation_check CHECK (presentation IS NULL OR presentation IN ('sellado', 'abierto'))`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['products', 'staged_products']) {
      await queryRunner.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_presentation_check`);
      await queryRunner.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS presentation`);
    }
  }
}
