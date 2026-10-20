import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductPhotoSafety1792454400000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    for (const table of ['products', 'staged_products']) {
      await q.query(`ALTER TABLE ${table} ADD COLUMN photos_hold boolean NOT NULL DEFAULT false,
        ADD COLUMN photos_hold_reason text, ADD COLUMN photos_hold_at timestamptz`);
    }
    // sold_records.sold_at is the existing authoritative sale date. Do not infer
    // dates from updated_at, sync timestamps or the date of this migration.
    await q.query(`CREATE TABLE photo_change_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid, staged_id uuid, sku text,
      url_old text, url_new text, action text NOT NULL, actor text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), error text,
      pending boolean NOT NULL DEFAULT false, cache_pending boolean NOT NULL DEFAULT false,
      dry_run boolean NOT NULL DEFAULT false, attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(
      `CREATE INDEX photo_change_log_pending ON photo_change_log(created_at) WHERE pending OR cache_pending`,
    );
    await q.query(
      `CREATE TABLE photo_jobs (name text PRIMARY KEY, last_completed_at timestamptz, last_error text)`,
    );
    for (const table of ['products', 'staged_products']) {
      await q.query(
        `ALTER TABLE ${table} ADD COLUMN photos_cleanup_status text, ADD COLUMN photos_cleanup_checked_at timestamptz`,
      );
    }
    // Tombstones/redirects contain URLs only, never image bytes or versions.
    await q.query(`CREATE TABLE photo_url_rules (
      sku text NOT NULL, url_old text NOT NULL, url_new text,
      PRIMARY KEY(sku, url_old)
    )`);
    // Enforce rules at the write boundary for BOTH sync entry points, stale
    // admin forms and publications. No extra per-item queries in inventory sync.
    await q.query(`CREATE FUNCTION photo_apply_rules(value jsonb, item_sku text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
      DECLARE kind text; result jsonb; entry record; text_value text; replacement text; seen text[] := '{}';
      BEGIN
        kind := jsonb_typeof(value);
        IF kind='array' THEN
          SELECT COALESCE(jsonb_agg(v) FILTER (WHERE v <> 'null'::jsonb),'[]'::jsonb) INTO result
          FROM (SELECT photo_apply_rules(e,item_sku) AS v FROM jsonb_array_elements(value) e) items;
          RETURN result;
        ELSIF kind='object' THEN
          result := '{}'::jsonb;
          FOR entry IN SELECT * FROM jsonb_each(value) LOOP
            result := result || jsonb_build_object(entry.key,photo_apply_rules(entry.value,item_sku));
          END LOOP;
          RETURN result;
        ELSIF kind='string' THEN
          text_value := value #>> '{}';
          LOOP
            EXIT WHEN text_value=ANY(seen);
            seen := array_append(seen,text_value);
            SELECT url_new INTO replacement FROM photo_url_rules WHERE sku=item_sku AND url_old=text_value;
            EXIT WHEN NOT FOUND;
            IF replacement IS NULL THEN RETURN 'null'::jsonb; END IF;
            text_value := replacement;
          END LOOP;
          IF left(ltrim(text_value),1) IN ('{','[') THEN
            BEGIN RETURN to_jsonb(photo_apply_rules(text_value::jsonb,item_sku)::text);
            EXCEPTION WHEN invalid_text_representation THEN RETURN to_jsonb(text_value); END;
          END IF;
          RETURN to_jsonb(text_value);
        END IF;
        RETURN value;
      END $$`);
    await q.query(`CREATE FUNCTION photo_guard_references() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE item_sku text;
      BEGIN
        IF TG_TABLE_NAME='staged_products' THEN
          item_sku := NEW.sku;
          IF EXISTS(SELECT 1 FROM photo_url_rules WHERE sku=item_sku AND strpos(NEW.images::text,url_old)>0) THEN
            NEW.images := photo_apply_rules(NEW.images,item_sku);
          END IF;
          IF EXISTS(SELECT 1 FROM photo_url_rules WHERE sku=item_sku AND strpos(COALESCE(NEW.notes,''),url_old)>0) THEN
            NEW.notes := photo_apply_rules(to_jsonb(NEW.notes),item_sku) #>> '{}';
          END IF;
        ELSE
          SELECT sku INTO item_sku FROM products WHERE id=NEW.product_id;
          IF EXISTS(SELECT 1 FROM photo_url_rules WHERE sku=item_sku AND strpos(NEW.images::text,url_old)>0) THEN
            NEW.images := photo_apply_rules(NEW.images,item_sku);
          END IF;
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(
      `CREATE TRIGGER photo_guard_staged BEFORE INSERT OR UPDATE OF images,notes ON staged_products FOR EACH ROW EXECUTE FUNCTION photo_guard_references()`,
    );
    await q.query(
      `CREATE TRIGGER photo_guard_public BEFORE INSERT OR UPDATE OF images ON catalog_public FOR EACH ROW EXECUTE FUNCTION photo_guard_references()`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TRIGGER photo_guard_public ON catalog_public');
    await q.query('DROP TRIGGER photo_guard_staged ON staged_products');
    await q.query('DROP FUNCTION photo_guard_references()');
    await q.query('DROP FUNCTION photo_apply_rules(jsonb,text)');
    await q.query('DROP TABLE photo_url_rules');
    await q.query('DROP TABLE photo_change_log');
    await q.query('DROP TABLE photo_jobs');
    for (const table of ['products', 'staged_products']) {
      await q.query(
        `ALTER TABLE ${table} DROP COLUMN photos_hold, DROP COLUMN photos_hold_reason, DROP COLUMN photos_hold_at, DROP COLUMN photos_cleanup_status, DROP COLUMN photos_cleanup_checked_at`,
      );
    }
  }
}
