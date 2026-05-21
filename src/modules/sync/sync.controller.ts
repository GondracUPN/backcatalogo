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
    const saleType = p?.saleType ?? p?.sale_type ?? null;
    const discount = p?.discount ?? null;
    const finalPrice = p?.finalPrice ?? p?.final_price ?? null;
    const minOfferPrice = p?.minOfferPrice ?? p?.min_offer_price ?? null;
    const iphoneModel = p?.iphoneModel ?? p?.iphone_model ?? null;
    const includes = p?.includes ?? null;
    const includesExtra = p?.includesExtra ?? p?.includes_extra ?? null;
    const keyboardLayout = p?.keyboardLayout ?? p?.keyboard_layout ?? null;
    const productCondition = p?.productCondition ?? p?.product_condition ?? null;

    // Normalizar specs (solo campos necesarios)
    const normSpecs = (() => {
      const s = p?.specs || {};
      const d = s?.detalle || {};
      const sim = d?.esim ?? d?.sim ?? s?.sim ?? null;
      return {
        tipo: s?.tipo ?? null,
        estado: s?.estado ?? null,
        sim,
        conCaja: s?.conCaja ?? null,
        detalle: {
          id: d?.id ?? null,
          esim: sim,
          gama: d?.gama ?? null,
          procesador: d?.procesador ?? null,
          generacion: d?.generacion ?? null,
          numero: d?.numero ?? null,
          modelo: d?.modelo ?? null,
          tamanio: d?.['tama\u00f1o'] ?? d?.tamanio ?? d?.tamano ?? null,
          almacenamiento: d?.almacenamiento ?? null,
          ram: d?.ram ?? null,
          conexion: d?.conexion ?? null,
          descripcionOtro: d?.descripcionOtro ?? null,
        },
        valor: { costoTotal: s?.valor?.costoTotal ?? null },
      } as any;
    })();

    // Upsert main products por SKU (UUID lo genera la DB)
    await this.products.upsert(
      {
        sku: p.sku,
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
        product_condition: productCondition ?? normSpecs?.estado ?? null,
      },
      { conflictPaths: ['sku'] },
    );

    // Upsert staged mirror by source_id (uuid derivado del id de origen)
    const sid = this.toDeterministicUuid(String(p.id ?? p.sku ?? 'unknown'));
    await this.staged.upsert(
      {
        source_id: sid,
        sku: p.sku,
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
