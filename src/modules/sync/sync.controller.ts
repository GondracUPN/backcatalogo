import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Post, Query, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { SyncLog } from '../../entities/sync-log.entity';
import { StagedProduct } from '../../entities/staged-product.entity';
import { CatalogPublic } from '../../entities/catalog-public.entity';
import * as crypto from 'node:crypto';
import { requireSyncSecret } from '../../utils/shared-secret';

type IncomingEvent = 'product.listed' | 'product.updated' | 'product.sold';

@Controller('api/sync')
export class SyncController {
  constructor(
    @InjectRepository(CatalogProduct) private products: Repository<CatalogProduct>,
    @InjectRepository(SyncLog) private logs: Repository<SyncLog>,
    @InjectRepository(StagedProduct) private staged: Repository<StagedProduct>,
    @InjectRepository(CatalogPublic) private publicCatalog: Repository<CatalogPublic>,
  ) {}

  private parseNotes(notes?: string | null) {
    try {
      return typeof notes === 'string' ? JSON.parse(notes) : (notes || {});
    } catch {
      return {};
    }
  }

  private async getExistingProtection(
    sku: string,
    product?: CatalogProduct | null,
    staged?: StagedProduct | null,
  ) {
    const productIds = Array.from(new Set([product?.id, staged?.source_id].filter(Boolean))) as string[];
    const publicRecord = productIds.length
      ? await this.publicCatalog.findOne({ where: productIds.map((product_id) => ({ product_id })) })
      : null;
    let sold = false;
    try {
      const soldRows = await this.products.manager.query(
        `SELECT 1
           FROM sold_records
          WHERE LOWER(COALESCE(sku, '')) = LOWER($1)
             OR product_id::text = ANY($2::text[])
          LIMIT 1`,
        [sku, productIds],
      );
      sold = soldRows.length > 0;
    } catch {
      // Instalaciones antiguas pueden no tener todavia la tabla de ventas.
    }
    const notes = this.parseNotes(staged?.notes);
    const isMergedPublication = Boolean(
      String(notes?.linkedMainSku || '').trim()
      || (Array.isArray(notes?.linkedSkus) && notes.linkedSkus.length)
      || String(notes?.linkedSkuGroup?.mainSku || '').trim(),
    );
    const status = String(staged?.status || product?.status || '').toLowerCase();
    const protectedStatus = !['', 'draft', 'listed'].includes(status);
    return {
      protected: Boolean(publicRecord) || sold || isMergedPublication || protectedStatus,
      published: Boolean(publicRecord?.is_published),
      previouslyPublished: Boolean(publicRecord),
      sold,
      merged: isMergedPublication,
      status,
    };
  }

  @Get('exists')
  @HttpCode(200)
  async exists(
    @Query('sku') sku?: string,
    @Query('id') id?: string,
    @Headers('x-sync-secret') syncSecret?: string,
    @Headers('authorization') authorization?: string,
  ) {
    requireSyncSecret({ secret: syncSecret, authorization });
    if (!sku && !id) return { exists: false };
    if (sku) {
      const normalizedSku = String(sku).trim().replace(/^svc(?=[-_\s]*\d)/i, 'MS');
      const p = await this.products.findOne({ where: { sku: normalizedSku } });
      const staged = await this.staged.findOne({ where: { sku: normalizedSku } });
      const protection = await this.getExistingProtection(normalizedSku, p, staged);
      const recordExists = Boolean(p || staged || protection.sold);
      return {
        exists: recordExists,
        status: protection.status || null,
        published: protection.published,
        previouslyPublished: protection.previouslyPublished,
        sold: protection.sold,
        merged: protection.merged,
        canRecalculate: recordExists && !protection.protected && protection.status === 'listed',
      };
    }
    if (id) {
      const sid = String(id);
      const p = await this.staged.findOne({ where: { source_id: sid } });
      return { exists: !!p };
    }
    return { exists: false };
  }

  // Genera un UUID determinstico (estilo v5) a partir de una clave string
  private toDeterministicUuid(key: string) {
    const ns = 'macsomenos-catalog';
    const hash = crypto
      .createHash('sha1')
      .update(ns + '|' + key)
      .digest();
    const bytes = Buffer.from(hash);
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = bytes.toString('hex');
    return (
      hex.substring(0, 8) + '-' +
      hex.substring(8, 12) + '-' +
      hex.substring(12, 16) + '-' +
      hex.substring(16, 20) + '-' +
      hex.substring(20, 32)
    );
  }

  // Snapshot del mismo inventario comercial, con autorización compartida y SKU estable.
  // Solo este namespace admite actualizaciones sobre una publicación existente.
  private async syncAccessory(idemKey: string, p: any) {
    const sku = String(p?.sku || '');
    if (!/^acc-(?:ref-\d+-[a-f0-9]{16}|lot-\d+)$/.test(sku)
      || typeof p.selected !== 'boolean' || !Number.isSafeInteger(p.stock) || p.stock < 0
      || typeof p.title !== 'string' || !p.title.trim()
      || !Number.isFinite(Number(p.price)) || Number(p.price) < 0
      || (p.selected && !(Number(p.price) > 0))) {
      throw new BadRequestException('Invalid accessory snapshot');
    }
    await this.products.manager.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['accessory:' + sku]);
      const logs = em.getRepository(SyncLog);
      if (await logs.findOne({ where: { idem_key: idemKey } })) return;
      const products = em.getRepository(CatalogProduct);
      const staged = em.getRepository(StagedProduct);
      const publications = em.getRepository(CatalogPublic);
      for (const oldSku of Array.isArray(p.legacySkus) ? p.legacySkus : []) {
        if (!/^MS-\d+$/.test(String(oldSku))) continue;
        const old = await products.findOne({ where: { sku: oldSku } });
        const oldStaged = await staged.findOne({ where: { sku: oldSku } });
        if (String(this.parseNotes(oldStaged?.notes)?.tipo).toLowerCase() !== 'accesorios') continue;
        if (old?.status === 'sold' || oldStaged?.status === 'sold') continue;
        // La limpieza preventiva no retira publicaciones realizadas en el panel.
        if (!p.selected && oldStaged?.status === ('published' as any)) continue;
        if (old) {
          await products.update({ id: old.id }, { stock: 0, status: 'draft' });
          await publications.update({ product_id: old.id }, { is_published: false });
        }
        if (oldStaged) {
          await staged.update({ id: oldStaged.id }, { stock: 0, status: 'hidden' });
          await publications.update({ product_id: oldStaged.source_id }, { is_published: false });
        }
      }
      const existing = await products.findOne({ where: { sku } });
      const id = existing?.id || this.toDeterministicUuid(sku);
      // Ventas iniciadas en el catálogo todavía sin confirmar en Servicios:
      // restarlas del snapshot local evita ofrecer dos veces esas unidades.
      let pending = 0;
      const tables = await em.query("SELECT to_regclass('sold_records') AS sales, to_regclass('sale_sync_events') AS events");
      if (tables[0]?.sales && tables[0]?.events) {
        const rows = await em.query(`SELECT count(*)::int AS qty FROM sold_records s
          WHERE s.sku = $1 AND NOT (s.id::text = ANY($2::text[]))`,
          [sku, Array.isArray(p.confirmedSales) ? p.confirmedSales.map(String) : []]);
        pending = Number(rows[0]?.qty || 0);
      }
      const previousStaged = await staged.findOne({ where: { sku } });
      const publication = await publications.findOne({ where: { product_id: id } });
      if (!p.selected && !existing && !previousStaged) {
        await logs.save(logs.create({ idem_key: idemKey }));
        return;
      }
      // Recibir inventario no equivale a publicar. Solo el panel marca published.
      const manuallyPublished = p.selected && publication?.is_published === true && previousStaged?.status === ('published' as any);
      const stock = p.selected ? Math.max(0, p.stock - pending) : 0;
      const status = manuallyPublished ? 'listed' : 'draft';
      const rawCondition = String(previousStaged?.product_condition || existing?.product_condition || p.productCondition || '').toLowerCase();
      const condition = /open\s*box/.test(rawCondition) ? 'Open Box' : /^(nuevo|sellado)$/.test(rawCondition) ? 'Nuevo' : 'Usado';
      const presentation = rawCondition === 'sellado' ? 'sellado' : null;
      // Recupera los títulos genéricos producidos por el editor antiguo; conserva nombres personalizados.
      const originalTitle = String(p.title || '').trim();
      const productTitle = !existing?.title || /^accesorios$/i.test(existing.title.trim()) ? originalTitle : existing.title;
      const stagedTitle = !previousStaged?.title || /^accesorios$/i.test(previousStaged.title.trim()) ? originalTitle : previousStaged.title;
      // El catálogo conserva precio, tipo de venta, notas y fotos editados aquí.
      await products.upsert({ ...(existing || {}), id, sku,
        title: productTitle, price: existing?.price ?? String(p.price), stock, status,
        sale_type: existing?.sale_type || 'VENTA_SIMPLE',
        product_condition: condition as any,
        presentation: existing?.presentation ?? presentation,
      }, { conflictPaths: ['sku'] });
      const notes = JSON.stringify({ ...(this.parseNotes(previousStaged?.notes) || { tipo: 'accesorios', productCondition: condition }), accessorySourceTitle: originalTitle, ...(Number.isSafeInteger(p.accessoryCode) && p.accessoryCode > 0 ? { accessoryCode: p.accessoryCode } : {}) });
      await staged.upsert({ ...(previousStaged || {}), source_id: id, sku,
        title: stagedTitle, price: previousStaged?.price ?? String(p.price), stock,
        status: (manuallyPublished ? 'published' : p.selected ? 'draft' : 'hidden') as any,
        category: previousStaged?.category || 'accesorios', images: previousStaged?.images || [], notes,
        sale_type: previousStaged?.sale_type || 'VENTA_SIMPLE',
        product_condition: condition,
        presentation: previousStaged?.presentation ?? presentation,
      }, { conflictPaths: ['source_id'] });
      if (publication) {
        await publications.save(publications.create({ ...publication, is_published: manuallyPublished }));
      }
      await logs.save(logs.create({ idem_key: idemKey }));
    });
    if (!process.env.MACSO_TEST_DATABASE_URL) {
      try {
        await fetch(`${process.env.NEXT_BASE_URL || 'http://127.0.0.1:3000'}/api/admin/revalidate`, {
          method: 'POST', signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json', ...(process.env.REVALIDATE_SECRET ? { 'x-revalidate-secret': process.env.REVALIDATE_SECRET } : {}) },
          body: JSON.stringify({ tags: ['catalog-products', 'catalog-staged'] }),
        });
      } catch {}
    }
    return { ok: true, accessorySnapshot: true };
  }

  @Post('product')
  @HttpCode(200)
  async syncProduct(
    @Headers('x-idempotency-key') idemKey: string,
    @Body() body: any,
    @Headers('x-sync-secret') syncSecret?: string,
    @Headers('authorization') authorization?: string,
  ): Promise<{ ok: boolean; accessorySnapshot?: boolean; idempotent?: boolean; skipped?: string; published?: boolean; previouslyPublished?: boolean; sold?: boolean; merged?: boolean }> {
    requireSyncSecret({ secret: syncSecret, authorization });
    if (!idemKey) throw new UnauthorizedException('missing idempotency key');

    if (body?.event === 'accessory.snapshot') return this.syncAccessory(idemKey, body.product);

    const exists = await this.logs.findOne({ where: { idem_key: idemKey } });
    if (exists) return { ok: true, idempotent: true };

    const evt: IncomingEvent = body?.event;
    const p = body?.product || {};
    if (evt !== 'product.sold' && [p.category, p.tipo, p.specs?.tipo].some((value) => String(value || '').trim().toLowerCase() === 'accesorios')) {
      return { ok: true, skipped: 'accessory_requires_explicit_selection' };
    }
    const sku = String(p?.sku || '').trim().replace(/^svc(?=[-_\s]*\d)/i, 'MS');
    if (!sku) throw new UnauthorizedException('missing sku');
    const sid = this.toDeterministicUuid(String(p.id ?? sku));
    const [existingProduct, existingStaged] = await Promise.all([
      this.products.findOne({ where: { sku } }),
      this.staged.findOne({ where: [{ source_id: sid }, { sku }] }),
    ]);
    const protection = await this.getExistingProtection(sku, existingProduct, existingStaged);
    if ((existingProduct || existingStaged) && (protection.protected || protection.status !== 'listed')) {
      await this.logs.save(this.logs.create({ idem_key: idemKey }));
      return {
        ok: true,
        skipped: 'protected',
        published: protection.published,
        previouslyPublished: protection.previouslyPublished,
        sold: protection.sold,
        merged: protection.merged,
      };
    }
    const saleType = p?.saleType ?? p?.sale_type ?? null;
    const discount = p?.discount ?? null;
    const finalPrice = p?.finalPrice ?? p?.final_price ?? null;
    const minOfferPrice = p?.minOfferPrice ?? p?.min_offer_price ?? null;
    const iphoneModel = p?.iphoneModel ?? p?.iphone_model ?? null;
    const sourceSpecs = p?.specs || {};
    const sourceDetail = sourceSpecs?.detalle || sourceSpecs?.detail || {};
    const rawIncludes = p?.includes ?? p?.incluye ?? p?.accessories ?? p?.accesorios ?? sourceSpecs?.includes ?? sourceSpecs?.incluye ?? sourceSpecs?.accessories ?? sourceSpecs?.accesorios ?? sourceDetail?.includes ?? sourceDetail?.incluye ?? sourceDetail?.accessories ?? sourceDetail?.accesorios ?? null;
    const includes: any = Array.isArray(rawIncludes)
      ? rawIncludes.map(String).map((value: string) => value.trim()).filter(Boolean).join(' + ')
      : rawIncludes && typeof rawIncludes === 'object'
        ? Object.entries(rawIncludes).filter(([, enabled]) => ![false, 0, '0', 'false', 'no', null, undefined, ''].includes(enabled as any)).map(([key]) => key).join(' + ')
        : rawIncludes === null ? null : String(rawIncludes).trim();
    const includesExtra = p?.includesExtra ?? p?.includes_extra ?? null;
    const keyboardLayout = p?.keyboardLayout ?? p?.keyboard_layout ?? null;
    const rawProductCondition = p?.productCondition ?? p?.product_condition ?? sourceSpecs?.estado ?? null;
    const productCondition = (() => {
      const value = String(rawProductCondition || '').trim();
      if (!value) return null;
      if (/^nuevo$/i.test(value)) return 'Nuevo';
      if (/^usado$/i.test(value)) return 'Usado';
      if (/open\s*box/i.test(value)) return 'Open Box';
      if (/arreglado|reparado/i.test(value)) return 'Arreglado';
      return value;
    })();
    const warrantyObject = p?.warranty ?? p?.garantiaDetalle ?? p?.coverage ?? p?.appleCare ?? p?.specs?.warranty ?? p?.specs?.garantiaDetalle ?? p?.specs?.coverage ?? p?.specs?.appleCare ?? {};
    const warrantyEnabled = p?.warrantyEnabled ?? p?.garantiaActiva ?? p?.specs?.warrantyEnabled ?? p?.specs?.garantiaActiva ?? null;
    const warrantyType = p?.warrantyType ?? p?.garantiaTipo ?? p?.specs?.warrantyType ?? p?.specs?.garantiaTipo ?? warrantyObject?.type ?? warrantyObject?.tipo ?? warrantyObject?.plan ?? null;
    const warrantyDate = p?.warrantyDate ?? p?.garantiaFecha ?? p?.garantia ?? p?.specs?.warrantyDate ?? p?.specs?.garantiaFecha ?? p?.specs?.garantia ?? warrantyObject?.date ?? warrantyObject?.fecha ?? warrantyObject?.hasta ?? warrantyObject?.expiresAt ?? warrantyObject?.expirationDate ?? null;
    const color = p?.color ?? p?.specs?.color ?? p?.specs?.detalle?.color ?? p?.specs?.detalle?.colorName ?? null;
    const batteryCyclesValue = p?.batteryCycles ?? p?.battery_cycles ?? null;
    const batteryHealthValue = p?.batteryHealth ?? p?.battery_health ?? null;
    const batteryCycles = batteryCyclesValue === null || batteryCyclesValue === ''
      ? null
      : Number(batteryCyclesValue);
    const batteryHealth = batteryHealthValue === null || batteryHealthValue === ''
      ? null
      : Number(batteryHealthValue);
    const watchLine = String(p?.watchType ?? p?.watch_type ?? sourceSpecs?.watchType ?? sourceDetail?.watchType ?? sourceDetail?.gama ?? '').trim();
    const isWatch = /watch/i.test(String(sourceSpecs?.tipo || p?.category || ''));
    const watchType = /ultra/i.test(watchLine) ? 'Ultra' : (isWatch || /series|se|normal/i.test(watchLine) ? 'Normal' : null);
    const watchGeneration = String(watchType === 'Ultra'
      ? (p?.watchVersion ?? p?.watch_version ?? sourceSpecs?.watchVersion ?? sourceDetail?.watchVersion ?? sourceDetail?.generacion ?? p?.watchSeries ?? p?.watch_series ?? sourceSpecs?.watchSeries ?? sourceDetail?.watchSeries ?? '')
      : (p?.watchSeries ?? p?.watch_series ?? sourceSpecs?.watchSeries ?? sourceDetail?.watchSeries ?? sourceDetail?.generacion ?? p?.watchVersion ?? p?.watch_version ?? sourceSpecs?.watchVersion ?? sourceDetail?.watchVersion ?? '')
    ).trim();
    const watchNumber = watchGeneration.replace(/^(?:series|ultra|se)\s*/i, '').trim() || null;
    const rawWatchConnection = p?.watchConnection ?? p?.watch_connection ?? sourceSpecs?.watchConnection ?? sourceDetail?.watchConnection ?? sourceDetail?.conexion ?? sourceDetail?.conectividad ?? null;
    const watchConnection = rawWatchConnection == null || String(rawWatchConnection).trim() === '' ? null : (/cel/i.test(String(rawWatchConnection)) ? 'GPS + Cellular' : 'GPS');
    const watchSize = String(p?.watchSize ?? p?.watch_size ?? sourceSpecs?.watchSize ?? sourceDetail?.watchSize ?? sourceDetail?.['tama\u00f1o'] ?? sourceDetail?.tamanio ?? sourceDetail?.tamano ?? '').match(/\b(\d+(?:\.\d+)?)\b/)?.[1] ?? null;
    const rawConnectivity = sourceDetail?.conectividad ?? sourceDetail?.conexion ?? sourceSpecs?.conectividad ?? p?.conectividad ?? null;
    const connectivity = rawConnectivity == null ? null : (/cel/i.test(String(rawConnectivity)) ? 'WiFi + Celular' : (/wi-?fi/i.test(String(rawConnectivity)) ? 'WiFi' : String(rawConnectivity).trim()));

    // Normalizar specs (solo campos necesarios)
    const normSpecs = (() => {
      const s = sourceSpecs;
      const d = s?.detalle || {};
      const sim = d?.esim ?? d?.sim ?? s?.sim ?? null;
      return {
        tipo: s?.tipo ?? null,
        estado: s?.estado ?? null,
        sim,
        conCaja: s?.conCaja ?? null,
        color,
        bateria: {
          ciclos: Number.isFinite(batteryCycles) ? batteryCycles : null,
          salud: Number.isFinite(batteryHealth) ? batteryHealth : null,
        },
        batteryCycles: Number.isFinite(batteryCycles) ? batteryCycles : null,
        batteryHealth: Number.isFinite(batteryHealth) ? batteryHealth : null,
        precioLista: p?.price ?? null,
        minOfferPrice,
        saleType,
        includes,
        includesExtra,
        productCondition: productCondition ?? s?.estado ?? null,
        warrantyEnabled,
        warrantyType,
        warrantyDate,
        garantiaActiva: warrantyEnabled,
        garantiaTipo: warrantyType,
        garantiaFecha: warrantyDate,
        garantia: warrantyDate,
        conectividad: connectivity,
        watchType,
        watchSeries: watchType === 'Normal' ? watchNumber : null,
        watchVersion: watchType === 'Ultra' ? watchNumber : null,
        watchConnection,
        watchSize,
        watchIncludes: isWatch ? includes : null,
        detalle: {
          id: d?.id ?? null,
          esim: sim,
          gama: d?.gama ?? null,
          procesador: d?.procesador ?? null,
          generacion: d?.generacion ?? null,
          numero: d?.numero ?? null,
          modelo: d?.modelo ?? null,
          tamanio: watchSize ?? d?.['tama\u00f1o'] ?? d?.tamanio ?? d?.tamano ?? null,
          almacenamiento: d?.almacenamiento ?? null,
          ram: d?.ram ?? null,
          color: d?.color ?? d?.colorName ?? color,
          includes: d?.includes ?? d?.incluye ?? includes,
          conexion: d?.conexion ?? null,
          conectividad: connectivity,
          descripcionOtro: d?.descripcionOtro ?? null,
        },
        valor: { costoTotal: s?.valor?.costoTotal ?? null },
      } as any;
    })();

    // Upsert main products por SKU (UUID lo genera la DB)
    await this.products.upsert(
      {
        sku,
        title: p.title,
        price: String(p.price ?? '0'),
        status: p.status,
        stock: Number(p.stock ?? 0),
        sale_type: saleType,
        discount,
        final_price: finalPrice,
        min_offer_price: minOfferPrice,
        iphone_model: iphoneModel,
        includes,
        includes_extra: includesExtra,
        keyboard_layout: keyboardLayout,
        battery_cycles: Number.isFinite(batteryCycles) ? batteryCycles : null,
        battery_health: Number.isFinite(batteryHealth) ? batteryHealth : null,
        color,
        product_condition: productCondition ?? normSpecs?.estado ?? null,
      },
      { conflictPaths: ['sku'] },
    );

    // Upsert staged mirror by source_id (uuid derivado del id de origen)
    await this.staged.upsert(
      {
        source_id: sid,
        sku,
        title: p.title,
        price: String(p.price ?? '0'),
        status: p.status,
        stock: Number(p.stock ?? 0),
        category: normSpecs?.tipo ?? null,
        tags: Array.isArray(p?.tags) ? p.tags : null,
        images: Array.isArray(p?.images) ? p.images : [],
        notes: JSON.stringify(normSpecs),
        sale_type: saleType,
        discount,
        final_price: finalPrice,
        min_offer_price: minOfferPrice,
        iphone_model: iphoneModel,
        includes,
        includes_extra: includesExtra,
        keyboard_layout: keyboardLayout,
        battery_cycles: Number.isFinite(batteryCycles) ? batteryCycles : null,
        battery_health: Number.isFinite(batteryHealth) ? batteryHealth : null,
        color,
        product_condition: productCondition ?? normSpecs?.estado ?? null,
      },
      { conflictPaths: ['source_id'] },
    );

    await this.logs.save(this.logs.create({ idem_key: idemKey }));

    // Ask Next.js to revalidate tags
    if (process.env.MACSO_TEST_DATABASE_URL) return { ok: true };
    const nextBase = process.env.NEXT_BASE_URL || 'http://127.0.0.1:3000';
    try {
      await fetch(`${nextBase}/api/admin/revalidate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.REVALIDATE_SECRET ? { 'x-revalidate-secret': String(process.env.REVALIDATE_SECRET) } : {}),
        },
        body: JSON.stringify({ tags: ['catalog-products', 'catalog-staged'] }),
      });
    } catch {}

    return { ok: true };
  }
}
