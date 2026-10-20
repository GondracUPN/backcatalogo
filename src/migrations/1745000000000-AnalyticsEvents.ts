import { MigrationInterface, QueryRunner } from 'typeorm';

// Aditiva: tabla de eventos de navegación para la analítica.
// No guarda IP, agente de usuario ni huella del dispositivo. Los
// identificadores de sesión/visitante son aleatorios y solo llegan si el
// visitante aceptó las cookies analíticas.
export class AnalyticsEvents1745000000000 implements MigrationInterface {
  name = 'AnalyticsEvents1745000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS analytics_events (
      id bigserial PRIMARY KEY,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      event_type text NOT NULL,
      consent boolean NOT NULL DEFAULT false,
      session_id text NULL,
      visitor_id text NULL,
      path text NULL,
      product_id uuid NULL,
      product_slug text NULL,
      category text NULL,
      query text NULL,
      results integer NULL,
      filters text[] NULL,
      duration_ms integer NULL,
      source text NULL,
      referrer_host text NULL,
      utm_source text NULL,
      utm_medium text NULL,
      utm_campaign text NULL,
      device text NULL,
      metadata jsonb NULL
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_analytics_events_time ON analytics_events (occurred_at)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_analytics_events_type_time ON analytics_events (event_type, occurred_at)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_analytics_events_product ON analytics_events (product_id, occurred_at) WHERE product_id IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS analytics_events`);
  }
}
