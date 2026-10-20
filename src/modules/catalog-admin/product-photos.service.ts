import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ownerUserIdForStaff, StaffPayload } from '../../utils/staff-auth';

export function cloudImageId(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'res.cloudinary.com') return '';
    const tail = parsed.pathname.split('/image/upload/')[1];
    if (!tail) return '';
    const parts = tail.split('/');
    const version = parts.findIndex((v) => /^v\d+$/.test(v));
    const start =
      version >= 0
        ? version + 1
        : parts.findIndex((v) => !v.includes(',') && !/^[a-z]{1,3}_/.test(v));
    return start < 0
      ? ''
      : decodeURIComponent(parts.slice(start).join('/')).replace(
          /\.[a-z0-9]+$/i,
          '',
        );
  } catch {
    return '';
  }
}

export function imageUrl(image: unknown): string {
  if (typeof image === 'string') return image;
  if (!image || typeof image !== 'object') return '';
  const value = image as Record<string, unknown>;
  return String(value.url || value.secure_url || value.src || '');
}

export function secondaryPhotoPlan(rows: Array<{ images?: unknown[] | null }>) {
  const covers = new Set(
    rows.map((row) => imageUrl(row.images?.[0])).filter(Boolean),
  );
  const urls = new Set<string>();
  for (const row of rows)
    for (const image of row.images || []) {
      const url = imageUrl(image);
      if (url && !covers.has(url)) urls.add(url);
    }
  return { covers, urls };
}

export function cleanupDecision(
  product: {
    status: string;
    stock?: number | string;
    presentation?: string | null;
    photos_hold?: boolean;
  },
  staged: Array<{ presentation?: string | null; photos_hold?: boolean }>,
  soldAt: string | Date | null | undefined,
  manual: boolean,
  days: number,
  now = Date.now(),
) {
  if (
    product.presentation === 'sellado' ||
    staged.some((s) => s.presentation === 'sellado')
  )
    return 'skip_sealed';
  if (product.photos_hold || staged.some((s) => s.photos_hold))
    return 'skip_hold';
  if (
    !['sold', 'hidden'].includes(product.status) ||
    Number(product.stock || 0) > 0
  )
    return 'not_sold';
  if (!soldAt || !Number.isFinite(new Date(soldAt).getTime())) return 'no_date';
  if (!manual && now - new Date(soldAt).getTime() < days * 86400000)
    return 'too_recent';
  return 'clean';
}

@Injectable()
export class ProductPhotosService implements OnModuleInit, OnModuleDestroy {
  private timers: Array<
    ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>
  > = [];
  private readonly logger = new Logger(ProductPhotosService.name);
  constructor(private readonly db: DataSource) {}
  onModuleInit() {
    const runDaily = () =>
      this.daily(false).catch((error) => this.logger.error(error.message));
    const runRetries = () =>
      this.drain().catch((error) => this.logger.error(error.message));
    this.timers = [
      setTimeout(runDaily, 2 * 60000),
      setInterval(runDaily, 20 * 60000),
      setTimeout(runRetries, 10000),
      setInterval(runRetries, 3 * 60000),
    ];
    this.timers.forEach((timer) => timer.unref());
  }
  onModuleDestroy() {
    this.timers.forEach((timer) => clearInterval(timer));
  }
  days() {
    const n = Number(process.env.SOLD_PHOTO_CLEANUP_DAYS || 60);
    return Number.isFinite(n) && n >= 1 ? n : 60;
  }

  async access(id: string, url: string, staff: StaffPayload) {
    const target = await this.target(this.db.manager, id, staff);
    return {
      ok: [...target.staged, ...target.pub].some((row) =>
        (row.images || []).some((v: any) => imageUrl(v) === url),
      ),
    };
  }

  async plan(id: string, staff: StaffPayload) {
    const { staged, pub } = await this.target(this.db.manager, id, staff);
    return {
      secondaryCount: secondaryPhotoPlan([...staged, ...pub]).urls.size,
    };
  }

  async target(
    manager: EntityManager,
    id: string,
    staff?: StaffPayload,
    lock = false,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new BadRequestException('Producto inválido');
    let [product] = await manager.query(
      `SELECT * FROM products WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    );
    const staged = await manager.query(
      `SELECT * FROM staged_products WHERE source_id=$1 OR id=$1 OR sku=$2 ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,
      [id, product?.sku || ''],
    );
    if (!product && staged[0]) {
      [product] = await manager.query(
        `SELECT * FROM products WHERE sku=$1 ${lock ? 'FOR UPDATE' : ''}`,
        [staged[0].sku],
      );
      if (!product)
        product = { ...staged[0], id: staged[0].id, catalog_product_id: null };
    }
    if (!product) throw new BadRequestException('Producto no encontrado');
    if (staff && String(staff.role).toUpperCase() !== 'ADMIN') {
      const expected = ownerUserIdForStaff(staff);
      if (
        !staged.length ||
        staged.some((s: any) => (s.owner_user_id ?? null) !== expected)
      )
        throw new ForbiddenException();
    }
    product = {
      ...product,
      catalog_product_id:
        product.catalog_product_id === null ? null : product.id,
      staged_id: staged[0]?.id || null,
    };
    const pub = await manager.query(
      `SELECT * FROM catalog_public WHERE product_id=$1 ${lock ? 'FOR UPDATE' : ''}`,
      [product.catalog_product_id || staged[0]?.source_id || product.id],
    );
    return { product, staged, pub };
  }

  /** Ante un error SQL no se borra. Se inspeccionan también notes, linkedSkus y variantes,
   * fotos de clientes, temáticas y configuración completa. */
  async isImageReferencedElsewhere(
    url: string,
    exceptProductId?: string,
    manager = this.db.manager,
  ) {
    const id = cloudImageId(url);
    for (const table of [
      'products',
      'catalog_public',
      'staged_products',
      'sold_records',
      'possible_clients',
      'site_themes',
      'catalog_settings',
    ]) {
      const exists = await manager.query('SELECT to_regclass($1) AS name', [
        `public.${table}`,
      ]);
      if (!exists[0]?.name) continue;
      const exclusion =
        exceptProductId && table === 'products'
          ? `AND t.id <> $3::uuid`
          : exceptProductId && table === 'catalog_public'
            ? `AND t.product_id <> $3::uuid`
            : '';
      const rows = await manager.query(
        `SELECT 1 FROM ${table} t WHERE
        (strpos(to_jsonb(t)::text,$1)>0 OR ($2<>'' AND strpos(to_jsonb(t)::text,$2)>0)) ${exclusion} LIMIT 1`,
        exclusion ? [url, id, exceptProductId] : [url, id],
      );
      if (rows.length) return true;
    }
    return false;
  }

  async audit(
    manager: EntityManager,
    product: {
      id: string | null;
      sku: string | null;
      catalog_product_id?: string | null;
      staged_id?: string | null;
    },
    old: string | null,
    next: string | null,
    action: string,
    actor: string,
    dry = false,
  ) {
    // Solo se registran URLs activas de producto conocidas.
    if (old && !this.allowedUrl(old)) old = null;
    const [log] = await manager.query(
      `INSERT INTO photo_change_log(product_id,staged_id,sku,url_old,url_new,action,actor,pending,cache_pending,dry_run)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        product.catalog_product_id === null ? null : product.id,
        product.staged_id || null,
        product.sku,
        old,
        next,
        action,
        actor,
        Boolean(old) && !dry,
        !dry && !action.startsWith('skip_'),
        dry,
      ],
    );
    return log.id;
  }
  allowedUrl(url: string) {
    return (
      /^\/uploads\/wm-[a-zA-Z0-9-]+\.(jpg|jpeg|png|webp|avif)$/.test(url) ||
      cloudImageId(url).startsWith('macsomenos/productos/')
    );
  }

  canReplaceUrl(old: string, next: string) {
    if (!this.allowedUrl(next)) return false;
    if (old.startsWith('/uploads/')) return this.allowedUrl(old);
    try {
      const source = new URL(old),
        destination = new URL(next);
      return (
        Boolean(cloudImageId(old)) &&
        source.hostname === 'res.cloudinary.com' &&
        source.pathname.split('/')[1] === destination.pathname.split('/')[1]
      );
    } catch {
      return false;
    }
  }

  async replace(id: string, old: string, next: string, staff: StaffPayload) {
    if (!this.canReplaceUrl(old, next) || old === next)
      throw new BadRequestException('URL inválida');
    const logId = await this.db.transaction(async (manager) => {
      const { product, staged, pub } = await this.target(
        manager,
        id,
        staff,
        true,
      );
      const rows = [...staged, ...pub];
      if (
        !rows.some((row) =>
          (row.images || []).some((v: any) => imageUrl(v) === old),
        )
      )
        throw new BadRequestException(
          'La imagen cambió; vuelve a abrir el producto',
        );
      await manager.query(
        `INSERT INTO photo_url_rules(sku,url_old,url_new) VALUES($1,$2,$3) ON CONFLICT(sku,url_old) DO UPDATE SET url_new=EXCLUDED.url_new`,
        [product.sku, old, next],
      );
      for (const [table, list] of [
        ['staged_products', staged],
        ['catalog_public', pub],
      ] as const) {
        for (const row of list) {
          const images = (row.images || []).map((v: any) =>
            imageUrl(v) === old
              ? typeof v === 'string'
                ? next
                : {
                    ...v,
                    ...Object.fromEntries(
                      ['url', 'secure_url', 'src']
                        .filter((k) => v[k] === old)
                        .map((k) => [k, next]),
                    ),
                  }
              : v,
          );
          await manager.query(
            `UPDATE ${table} SET images=$1::jsonb,updated_at=now() WHERE id=$2`,
            [JSON.stringify(images), row.id],
          );
        }
      }
      // Actualiza también la portada asociada a las ventas.
      for (const table of ['sold_records', 'possible_clients']) {
        const exists = await manager.query('SELECT to_regclass($1) AS name', [
          `public.${table}`,
        ]);
        if (exists[0]?.name)
          await manager.query(
            `UPDATE ${table} SET product_image_url=$1 WHERE product_id=$2 AND product_image_url=$3`,
            [next, product.id, old],
          );
      }
      const log = await this.audit(
        manager,
        product,
        old,
        next,
        'edit_replace',
        String(staff.sub),
      );
      await manager.query(
        'UPDATE photo_change_log SET pending=false,cache_pending=false WHERE url_old=$1 AND product_id IS NULL',
        [next],
      );
      return log;
    });
    // Después del commit, un fallo físico queda en la cola y no revierte la referencia.
    await this.drain(id, logId).catch((e) => this.logger.error(e.message));
    return { ok: true, url: next };
  }

  async hold(id: string, hold: boolean, reason: string, staff: StaffPayload) {
    if (typeof hold !== 'boolean' || (hold && !reason.trim()))
      throw new BadRequestException('Indica el motivo de retención');
    await this.db.transaction(async (manager) => {
      const { product, staged } = await this.target(manager, id, staff, true);
      await manager.query(
        'UPDATE products SET photos_hold=$1,photos_hold_reason=$2,photos_hold_at=$3 WHERE id=$4',
        [
          hold,
          hold ? reason.slice(0, 1000) : null,
          hold ? new Date() : null,
          product.id,
        ],
      );
      for (const s of staged)
        await manager.query(
          'UPDATE staged_products SET photos_hold=$1,photos_hold_reason=$2,photos_hold_at=$3 WHERE id=$4',
          [
            hold,
            hold ? reason.slice(0, 1000) : null,
            hold ? new Date() : null,
            s.id,
          ],
        );
    });
    return { ok: true };
  }

  async cleanup(id: string, manual: boolean, actor: string, dry = false) {
    const result = await this.db.transaction(async (manager) => {
      const { product, staged, pub } = await this.target(
        manager,
        id,
        undefined,
        true,
      );
      const exists = await manager.query(
        `SELECT to_regclass('public.sold_records') AS name`,
      );
      const [sale] = exists[0]?.name
        ? await manager.query(
            'SELECT id,sold_at FROM sold_records WHERE product_id=$1 OR sku=$2 ORDER BY sold_at DESC NULLS LAST,id DESC LIMIT 1',
            [product.id, product.sku],
          )
        : [];
      const syncTable = await manager.query(
        `SELECT to_regclass('public.sale_sync_events') AS name`,
      );
      const [event] =
        sale && syncTable[0]?.name
          ? await manager.query(
              'SELECT remote_status,status FROM sale_sync_events WHERE sale_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
              [sale.id],
            )
          : [];
      const pending =
        [
          'pending_confirmation',
          'pending_cancellation_confirmation',
          'rejected',
        ].includes(event?.remote_status) ||
        (event && !event.remote_status && event.status !== 'sent');
      const decision = pending
        ? 'skip_sale_pending'
        : cleanupDecision(product, staged, sale?.sold_at, manual, this.days());
      if (decision !== 'clean') {
        const [previousCheck] = decision.startsWith('skip_')
          ? await manager.query(
              `SELECT action FROM photo_change_log WHERE (product_id=$1 OR staged_id=$1) ORDER BY created_at DESC,id DESC LIMIT 1`,
              [product.id],
            )
          : [];
        if (
          decision.startsWith('skip_') &&
          previousCheck?.action !== decision
        ) {
          await this.audit(manager, product, null, null, decision, actor, dry);
          const table = product.catalog_product_id
            ? 'products'
            : 'staged_products';
          if (!dry)
            await manager.query(
              `UPDATE ${table} SET photos_cleanup_status=$1,photos_cleanup_checked_at=now() WHERE id=$2`,
              [decision, product.id],
            );
        }
        if (manual && decision === 'not_sold')
          throw new BadRequestException('Solo se limpian productos vendidos');
        return { ok: true, removed: 0, skipped: decision };
      }
      const { covers, urls } = secondaryPhotoPlan([...staged, ...pub]);
      for (const [table, list] of [
        ['staged_products', staged],
        ['catalog_public', pub],
      ] as const) {
        for (const row of list) {
          const images = row.images || [];
          const keep = images.filter(
            (v: any, i: number) => i === 0 || covers.has(imageUrl(v)),
          );
          if (!dry)
            await manager.query(
              `UPDATE ${table} SET images=$1::jsonb,updated_at=now() WHERE id=$2`,
              [JSON.stringify(keep), row.id],
            );
        }
      }
      for (const url of urls) {
        await this.audit(
          manager,
          product,
          url,
          null,
          manual ? 'cleanup_manual' : 'cleanup_auto',
          actor,
          dry,
        );
        if (!dry)
          await manager.query(
            `INSERT INTO photo_url_rules(sku,url_old,url_new) VALUES($1,$2,NULL) ON CONFLICT(sku,url_old) DO UPDATE SET url_new=NULL`,
            [product.sku, url],
          );
      }
      if (!dry) {
        const table = product.catalog_product_id
          ? 'products'
          : 'staged_products';
        await manager.query(
          `UPDATE ${table} SET photos_cleanup_status='clean',photos_cleanup_checked_at=now() WHERE id=$1`,
          [product.id],
        );
      }
      return {
        ok: true,
        removed: dry ? 0 : urls.size,
        candidates: urls.size,
        dryRun: dry,
      };
    });
    if (manual && result.skipped === 'skip_hold')
      throw new BadRequestException('Quita la retención antes de limpiar');
    if (!dry) await this.drain(id).catch((e) => this.logger.error(e.message));
    return result;
  }

  async discard(url: string, actor: string) {
    if (!this.allowedUrl(url)) throw new BadRequestException('URL inválida');
    await this.audit(
      this.db.manager,
      { id: null, sku: null },
      url,
      null,
      'edit_replace',
      actor,
    );
    await this.drain().catch((e) => this.logger.error(e.message));
  }

  async reserve(id: string, old: string, next: string, staff: StaffPayload) {
    if (
      !this.canReplaceUrl(old, next) ||
      !(await this.access(id, old, staff)).ok
    )
      throw new BadRequestException('Imagen no disponible');
    // Reserve cleanup BEFORE uploading. A crash/disconnect leaves a retryable job,
    // with a grace period longer than the bounded upload/commit request.
    const log = await this.audit(
      this.db.manager,
      { id: null, sku: null },
      next,
      null,
      'edit_replace',
      String(staff.sub),
    );
    await this.db.query(
      `UPDATE photo_change_log SET available_at=now()+interval '1 hour',cache_pending=false WHERE id=$1`,
      [log],
    );
    return { ok: true };
  }

  async drain(productId?: string, logId?: string) {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    let locked = false;
    try {
      locked = (
        await runner.query('SELECT pg_try_advisory_lock(740602) AS locked')
      )[0]?.locked;
      if (!locked) return;
      const logs = await runner.query(
        `SELECT * FROM photo_change_log WHERE (pending OR cache_pending) AND available_at<=now() ${productId ? 'AND (product_id=$1 OR staged_id=$1 OR staged_id IN (SELECT id FROM staged_products WHERE source_id=$1))' : ''} ${logId ? 'AND id=$2' : ''} ORDER BY created_at LIMIT 50`,
        logId ? [productId, logId] : productId ? [productId] : [],
      );
      for (const log of logs) {
        try {
          if (log.pending) {
            if (await this.isImageReferencedElsewhere(log.url_old)) {
              await runner.query(
                `UPDATE photo_change_log SET pending=false,action='skip_shared',error=NULL WHERE id=$1`,
                [log.id],
              );
            } else {
              await this.internal('/api/admin/photos/delete-file', {
                url: log.url_old,
              });
              await runner.query(
                'UPDATE photo_change_log SET pending=false,error=NULL WHERE id=$1',
                [log.id],
              );
            }
          }
          await this.internal('/api/admin/revalidate', {
            tags: ['catalog-products', 'catalog-staged'],
          });
          await runner.query(
            'UPDATE photo_change_log SET cache_pending=false,error=NULL WHERE id=$1',
            [log.id],
          );
        } catch (e: any) {
          await runner.query(
            'UPDATE photo_change_log SET attempts=attempts+1,error=$2 WHERE id=$1',
            [log.id, String(e.message).slice(0, 1000)],
          );
        }
      }
    } finally {
      if (locked) await runner.query('SELECT pg_advisory_unlock(740602)');
      await runner.release();
    }
  }
  private async internal(route: string, body: any) {
    const base = process.env.FRONTEND_INTERNAL_URL || process.env.NEXT_BASE_URL;
    const deleting = route.endsWith('/delete-file');
    const secret = deleting
      ? process.env.PHOTO_DELETE_SECRET
      : process.env.REVALIDATE_SECRET;
    if (!base || !secret)
      throw new Error(
        'Configura FRONTEND_INTERNAL_URL, PHOTO_DELETE_SECRET y REVALIDATE_SECRET',
      );
    const res = await fetch(`${base.replace(/\/$/, '')}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [deleting ? 'x-photo-delete-secret' : 'x-revalidate-secret']: secret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok)
      throw new Error(`Operación de fotos ${route}: HTTP ${res.status}`);
  }
  async daily(force = true) {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    let locked = false;
    try {
      locked = (
        await runner.query('SELECT pg_try_advisory_lock(740601) AS locked')
      )[0]?.locked;
      if (!locked) return;
      await runner.query(
        `DELETE FROM photo_change_log WHERE NOT pending AND NOT cache_pending AND created_at < now() - interval '180 days'`,
      );
      if (process.env.SOLD_PHOTO_CLEANUP_ENABLED !== 'true') return;
      await runner.query(
        `INSERT INTO photo_jobs(name) VALUES('sold_cleanup') ON CONFLICT DO NOTHING`,
      );
      const [job] = await runner.query(
        `SELECT last_completed_at FROM photo_jobs WHERE name='sold_cleanup'`,
      );
      if (
        !force &&
        job?.last_completed_at &&
        Date.now() - new Date(job.last_completed_at).getTime() < 86400000
      )
        return;
      const dry = process.env.SOLD_PHOTO_CLEANUP_DRY_RUN !== 'false';
      // La paginación por clave avanza aunque haya productos retenidos.
      let cursor = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const rows = await runner.query(
          `SELECT id FROM (
          SELECT id FROM products WHERE status IN ('sold','hidden')
          UNION SELECT source_id AS id FROM staged_products s WHERE status IN ('sold','hidden')
            AND NOT EXISTS(SELECT 1 FROM products product WHERE product.sku=s.sku)
        ) sold WHERE id>$1 ORDER BY id LIMIT 50`,
          [cursor],
        );
        if (!rows.length) break;
        for (const row of rows)
          await this.cleanup(row.id, false, 'system', dry);
        cursor = rows[rows.length - 1].id;
      }
      await runner.query(
        "UPDATE photo_jobs SET last_completed_at=now(),last_error=NULL WHERE name='sold_cleanup'",
      );
    } finally {
      if (locked) await runner.query('SELECT pg_advisory_unlock(740601)');
      await runner.release();
    }
  }
}
