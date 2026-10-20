import { MigrationInterface, QueryRunner } from 'typeorm';

// Aditiva: solicitudes de compra con número, estados, historial y reservas.
// No usa claves foráneas hacia tablas creadas en tiempo de ejecución
// (contact_requests); solo hacia las tablas nuevas de esta misma migración.
export class PurchaseRequests1744000000000 implements MigrationInterface {
  name = 'PurchaseRequests1744000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS purchase_request_number_seq START 1`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS purchase_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      number text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'nueva',
      submission_key text NULL,
      owner_group text NOT NULL DEFAULT 'shared',
      contact_request_id uuid NULL,
      customer_name text NOT NULL,
      customer_phone text NOT NULL,
      delivery_option_id uuid NULL,
      delivery_option_name text NULL,
      delivery_kind text NULL,
      delivery_point_id uuid NULL,
      location_text text NULL,
      district text NULL,
      address text NULL,
      notes text NULL,
      delivery_cost numeric(12,2) NOT NULL DEFAULT 0,
      items_total numeric(12,2) NOT NULL DEFAULT 0,
      owner_user_id integer NULL,
      source text NOT NULL DEFAULT 'web',
      status_changed_at timestamptz NOT NULL DEFAULT now(),
      confirmed_at timestamptz NULL,
      paid_at timestamptz NULL,
      delivered_at timestamptz NULL,
      cancelled_at timestamptz NULL,
      cancel_reason text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT purchase_requests_status_check CHECK (status IN ('nueva','pendiente_confirmacion','confirmada','reservada','pagada','en_preparacion','enviada','entregada','cancelada'))
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_requests_submission ON purchase_requests(submission_key, owner_group) WHERE submission_key IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_purchase_requests_status ON purchase_requests(status, created_at DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_purchase_requests_owner ON purchase_requests(owner_user_id, created_at DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_purchase_requests_contact ON purchase_requests(contact_request_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_purchase_requests_point ON purchase_requests(delivery_point_id)`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS purchase_request_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
      product_id uuid NULL,
      sku text NULL,
      title text NOT NULL,
      color text NULL,
      qty integer NOT NULL DEFAULT 1,
      unit_price numeric(12,2) NOT NULL DEFAULT 0,
      line_total numeric(12,2) NOT NULL DEFAULT 0
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_purchase_request_items_request ON purchase_request_items(request_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_purchase_request_items_product ON purchase_request_items(product_id)`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS purchase_request_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
      from_status text NULL,
      to_status text NOT NULL,
      actor_user_id integer NULL,
      actor_username text NULL,
      note text NULL,
      metadata jsonb NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_purchase_request_events_request ON purchase_request_events(request_id, created_at)`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS stock_reservations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
      product_id uuid NOT NULL,
      qty integer NOT NULL,
      expires_at timestamptz NULL,
      released_at timestamptz NULL,
      created_by text NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_stock_reservations_active ON stock_reservations(product_id) WHERE released_at IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS stock_reservations`);
    await queryRunner.query(`DROP TABLE IF EXISTS purchase_request_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS purchase_request_items`);
    await queryRunner.query(`DROP TABLE IF EXISTS purchase_requests`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS purchase_request_number_seq`);
  }
}
