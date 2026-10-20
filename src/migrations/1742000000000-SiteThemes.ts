import { MigrationInterface, QueryRunner } from 'typeorm';

// Aditiva: solo crea una tabla nueva. No toca datos existentes.
export class SiteThemes1742000000000 implements MigrationInterface {
  name = 'SiteThemes1742000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS site_themes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      preset text NOT NULL DEFAULT 'custom',
      mode text NOT NULL DEFAULT 'scheduled',
      starts_at timestamptz NULL,
      ends_at timestamptz NULL,
      recurring_yearly boolean NOT NULL DEFAULT false,
      priority integer NOT NULL DEFAULT 0,
      colors jsonb NOT NULL DEFAULT '{}'::jsonb,
      banner jsonb NOT NULL DEFAULT '{}'::jsonb,
      effect text NOT NULL DEFAULT 'none',
      updated_by text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT site_themes_mode_check CHECK (mode IN ('scheduled', 'on', 'off'))
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_site_themes_mode ON site_themes(mode)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS site_themes`);
  }
}
