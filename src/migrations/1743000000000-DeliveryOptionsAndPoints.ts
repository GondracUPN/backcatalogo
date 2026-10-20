import { MigrationInterface, QueryRunner } from 'typeorm';

// Aditiva: tablas nuevas + 2 opciones iniciales que replican el comportamiento
// actual del carrito (recojo en almacén / punto medio por distrito).
export class DeliveryOptionsAndPoints1743000000000 implements MigrationInterface {
  name = 'DeliveryOptionsAndPoints1743000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS delivery_options (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE,
      name text NOT NULL,
      kind text NOT NULL,
      description text NULL,
      cost numeric(12,2) NOT NULL DEFAULT 0,
      cost_note text NULL,
      schedule text NULL,
      conditions text NULL,
      requires_point boolean NOT NULL DEFAULT false,
      requires_district boolean NOT NULL DEFAULT false,
      requires_address boolean NOT NULL DEFAULT false,
      active boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT delivery_options_kind_check CHECK (kind IN ('pickup','cash_on_delivery','meeting_point','delivery','province','other'))
    )`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS delivery_points (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      name_key text NOT NULL UNIQUE,
      aliases text[] NOT NULL DEFAULT '{}',
      alias_keys text[] NOT NULL DEFAULT '{}',
      kind text NOT NULL DEFAULT 'meeting_point',
      district text NULL,
      address text NULL,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT delivery_points_kind_check CHECK (kind IN ('warehouse','mall','meeting_point','other'))
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_delivery_points_alias_keys ON delivery_points USING GIN (alias_keys)`);
    await queryRunner.query(`INSERT INTO delivery_options (code, name, kind, description, cost, requires_point, requires_district, sort_order)
      VALUES
        ('almacen', 'Recojo en almacén', 'pickup', 'Recoge tu equipo en nuestro almacén en Surco.', 0, false, false, 0),
        ('punto_medio', 'Entrega en punto medio', 'meeting_point', 'Coordinamos un punto de encuentro en tu distrito.', 0, false, true, 10)
      ON CONFLICT (code) DO NOTHING`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS delivery_points`);
    await queryRunner.query(`DROP TABLE IF EXISTS delivery_options`);
  }
}
