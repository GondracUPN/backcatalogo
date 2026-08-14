import { Body, Controller, Get, Headers, HttpCode, Post, Query, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { SyncLog } from '../../entities/sync-log.entity';
import { StagedProduct } from '../../entities/staged-product.entity';
import * as crypto from 'node:crypto';

type IncomingEvent = 'product.listed' | 'product.updated' | 'product.sold';

@Controller('api/sync')
export class SyncController {
  constructor(
    @InjectRepository(CatalogProduct) private products: Repository<CatalogProduct>,
    @InjectRepository(SyncLog) private logs: Repository<SyncLog>,
    @InjectRepository(StagedProduct) private staged: Repository<StagedProduct>,
  ) {}

  private verifyHmac(raw: string, signature?: string) {
    const secret = process.env.SYNC_SECRET || '';
    const h = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    return h === (signature || '').toLowerCase();
  }

  @Get('exists')
  @HttpCode(200)
  async exists(@Query('sku') sku?: string, @Query('id') id?: string) {
    if (!sku && !id) return { exists: false };
    if (sku) {
      const p = await this.products.findOne({ where: { sku } });
      return { exists: !!p };
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

  @Post('product')
  @HttpCode(200)
  async syncProduct(
    @Headers('x-signature') signature: string,
    @Headers('x-idempotency-key') idemKey: string,
    @Body() body: any,
  ) {
    const raw = JSON.stringify(body || {});
    if (!this.verifyHmac(raw, signature)) throw new UnauthorizedException('invalid signature');
    if (!idemKey) throw new UnauthorizedException('missing idempotency key');

    const exists = await this.logs.findOne({ where: { idem_key: idemKey } });
    if (exists) return { ok: true, idempotent: true };

    const evt: IncomingEvent = body?.event;
    const p = body?.product || {};
    const sku = String(p?.sku || '').trim().replace(/^svc(?=[-_\s]*\d)/i, 'MS');
    if (!sku) throw new UnauthorizedException('missing sku');
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
    const watchGeneration = String(p?.watchSeries ?? p?.watch_series ?? p?.watchVersion ?? p?.watch_version ?? sourceSpecs?.watchSeries ?? sourceSpecs?.watchVersion ?? sourceDetail?.watchSeries ?? sourceDetail?.watchVersion ?? sourceDetail?.generacion ?? '').trim();
    const isWatch = /watch/i.test(String(sourceSpecs?.tipo || p?.category || ''));
    const watchType = /ultra/i.test(watchLine) ? 'Ultra' : (isWatch || /series|se|normal/i.test(watchLine) ? 'Normal' : null);
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
    const sid = this.toDeterministicUuid(String(p.id ?? sku));
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
    const nextBase = process.env.NEXT_BASE_URL || 'http://127.0.0.1:3000';
    try {
      await fetch(`${nextBase}/api/admin/revalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': process.env.SYNC_SECRET || '' },
        body: JSON.stringify({ tags: ['catalog-products', 'catalog-staged'] }),
      });
    } catch {}

    return { ok: true };
  }
}
