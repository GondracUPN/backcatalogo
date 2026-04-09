import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogProduct, IncludesKind, IphoneModel, KeyboardLayout, ProductCondition, SaleType } from '../../entities/catalog-product.entity';
import { StagedProduct } from '../../entities/staged-product.entity';
import * as crypto from 'node:crypto';

type UpstreamKind = 'catalog' | 'staged';

function asSaleType(value: string | null) {
  return value as SaleType | null;
}

function asIphoneModel(value: string | null) {
  return value as IphoneModel | null;
}

function asIncludesKind(value: string | null) {
  return value as IncludesKind | null;
}

function asKeyboardLayout(value: string | null) {
  return value as KeyboardLayout | null;
}

function asProductCondition(value: string | null) {
  return value as ProductCondition | null;
}

@Injectable()
export class PullSyncService {
  private logger = new Logger(PullSyncService.name);

  constructor(
    @InjectRepository(CatalogProduct) private products: Repository<CatalogProduct>,
    @InjectRepository(StagedProduct) private staged: Repository<StagedProduct>,
  ) {}

  private syncOnReadEnabled() {
    const raw = String(process.env.UPSTREAM_SYNC_ON_READ || '1').toLowerCase();
    return raw !== '0' && raw !== 'false' && raw !== 'off';
  }

  private upstreamBase() {
    const raw = process.env.UPSTREAM_API_BASE || '';
    return raw.trim().replace(/\/+$/, '');
  }

  private buildUrl(kind: UpstreamKind) {
    const base = this.upstreamBase();
    if (!base) return '';
    const path =
      kind === 'catalog'
        ? (process.env.UPSTREAM_CATALOG_PATH || '/catalog')
        : (process.env.UPSTREAM_STAGED_PATH || '/admin/staged');
    if (/^https?:\/\//i.test(path)) return path;
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private headers() {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const raw = process.env.UPSTREAM_API_TOKEN || '';
    if (raw) {
      const name = process.env.UPSTREAM_AUTH_HEADER || 'Authorization';
      headers[name] = raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
    }
    const apiKey = process.env.UPSTREAM_API_KEY || '';
    if (apiKey) headers['x-api-key'] = apiKey;
    return headers;
  }

  private extractItems(payload: any): any[] {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.products)) return payload.products;
    return [];
  }

  private toDeterministicUuid(key: string) {
    const ns = 'macsomenos-catalog';
    const hash = crypto
      .createHash('sha1')
      .update(ns + '|' + key)
      .digest();
    const bytes = Buffer.from(hash);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return (
      hex.substring(0, 8) + '-' +
      hex.substring(8, 12) + '-' +
      hex.substring(12, 16) + '-' +
      hex.substring(16, 20) + '-' +
      hex.substring(20, 32)
    );
  }

  private normalizeArray(val: any): string[] | null {
    if (!val) return null;
    if (Array.isArray(val)) return val.map(String);
    if (typeof val === 'string') return [val];
    return null;
  }

  private normalizeNotes(notes: any): string | null {
    if (!notes) return null;
    if (typeof notes === 'string') return notes;
    try {
      return JSON.stringify(notes);
    } catch {
      return null;
    }
  }

  private pickValue<T>(...vals: Array<T | undefined | null>): T | undefined {
    for (const v of vals) if (v !== undefined && v !== null && v !== '') return v as T;
    return undefined;
  }

  private async upsertFromItem(item: any) {
    const product = item?.product || item?.producto || item;
    const staged = item?.staged || item?.staged_product || item?.stage || null;

    const sku = this.pickValue(product?.sku, staged?.sku, item?.sku);
    if (!sku) return;

    const title = this.pickValue(product?.title, staged?.title, item?.title, '') || '';
    const price = this.pickValue(product?.price, staged?.price, item?.price, '0') as any;
    const status = this.pickValue(product?.status, staged?.status, item?.status, 'listed') as any;
    const stock = Number(this.pickValue(product?.stock, staged?.stock, item?.stock, 0) as any) || 0;

    const saleType = this.pickValue(
      staged?.sale_type,
      staged?.saleType,
      item?.sale_type,
      item?.saleType,
      product?.sale_type,
      product?.saleType,
      null,
    ) as any;
    const discount = this.pickValue(staged?.discount, item?.discount, product?.discount, null) as any;
    const finalPrice = this.pickValue(
      staged?.final_price,
      staged?.finalPrice,
      item?.final_price,
      item?.finalPrice,
      product?.final_price,
      product?.finalPrice,
      null,
    ) as any;
    const minOffer = this.pickValue(
      staged?.min_offer_price,
      staged?.minOfferPrice,
      item?.min_offer_price,
      item?.minOfferPrice,
      product?.min_offer_price,
      product?.minOfferPrice,
      null,
    ) as any;
    const iphoneModel = this.pickValue(
      staged?.iphone_model,
      staged?.iphoneModel,
      item?.iphone_model,
      item?.iphoneModel,
      product?.iphone_model,
      product?.iphoneModel,
      null,
    ) as any;
    const includes = this.pickValue(staged?.includes, item?.includes, product?.includes, null) as any;
    const includesExtra = this.pickValue(
      staged?.includes_extra,
      staged?.includesExtra,
      item?.includes_extra,
      item?.includesExtra,
      product?.includes_extra,
      product?.includesExtra,
      null,
    ) as any;
    const keyboardLayout = this.pickValue(
      staged?.keyboard_layout,
      staged?.keyboardLayout,
      item?.keyboard_layout,
      item?.keyboardLayout,
      product?.keyboard_layout,
      product?.keyboardLayout,
      null,
    ) as any;
    const productCondition = this.pickValue(
      staged?.product_condition,
      staged?.productCondition,
      item?.product_condition,
      item?.productCondition,
      product?.product_condition,
      product?.productCondition,
      null,
    ) as any;

    const category = this.pickValue(staged?.category, item?.category, product?.category, null) as any;
    const tags = this.normalizeArray(this.pickValue(staged?.tags, item?.tags, null));
    const images = Array.isArray(this.pickValue(staged?.images, item?.images, product?.images)) ? this.pickValue(staged?.images, item?.images, product?.images) : [];
    const notes = this.normalizeNotes(this.pickValue(staged?.notes, item?.notes, null));

    await this.products.upsert(
      {
        sku: String(sku),
        title: String(title),
        price: String(price ?? '0'),
        status,
        stock,
        sale_type: asSaleType(saleType ?? null),
        discount: discount ?? null,
        final_price: finalPrice ?? null,
        min_offer_price: minOffer ?? null,
        iphone_model: asIphoneModel(iphoneModel ?? null),
        includes: asIncludesKind(includes ?? null),
        includes_extra: includesExtra ?? null,
        keyboard_layout: asKeyboardLayout(keyboardLayout ?? null),
        product_condition: asProductCondition(productCondition ?? null),
      },
      { conflictPaths: ['sku'] },
    );

    const sourceRaw = this.pickValue(staged?.source_id, item?.id, product?.id, sku);
    const sourceId = /^[0-9a-f-]{36}$/i.test(String(sourceRaw || '')) ? String(sourceRaw) : this.toDeterministicUuid(String(sourceRaw));
    await this.staged.upsert(
      {
        source_id: sourceId,
        sku: String(sku),
        title: String(title),
        price: String(price ?? '0'),
        status,
        stock,
        sale_type: saleType ?? null,
        discount: discount ?? null,
        final_price: finalPrice ?? null,
        min_offer_price: minOffer ?? null,
        iphone_model: iphoneModel ?? null,
        includes: includes ?? null,
        includes_extra: includesExtra ?? null,
        keyboard_layout: keyboardLayout ?? null,
        product_condition: productCondition ?? null,
        category: category ? String(category) : null,
        tags,
        images: Array.isArray(images) ? images : [],
        notes,
      },
      { conflictPaths: ['source_id'] },
    );
  }

  async sync(kind: UpstreamKind) {
    if (!this.syncOnReadEnabled()) return { ok: false, reason: 'disabled' };
    const url = this.buildUrl(kind);
    if (!url) return { ok: false, reason: 'no_upstream' };

    const res = await fetch(url, { headers: this.headers() }).catch((e: unknown) => {
      this.logger.warn(`upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      return null as any;
    });
    if (!res || !res.ok) {
      this.logger.warn(`upstream fetch failed: ${res?.status || 'no-response'} ${url}`);
      return { ok: false, reason: 'fetch_failed' };
    }

    const payload = await res.json().catch(() => null);
    const items = this.extractItems(payload);
    for (const it of items) {
      try {
        await this.upsertFromItem(it);
      } catch (e: unknown) {
        this.logger.warn(`upsert failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { ok: true, count: items.length };
  }

  async syncCatalog() {
    return this.sync('catalog');
  }

  async syncStaged() {
    return this.sync('staged');
  }
}
