import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogProduct, IncludesKind, IphoneModel, KeyboardLayout, ProductCondition, SaleType } from '../../entities/catalog-product.entity';
import { StagedProduct } from '../../entities/staged-product.entity';
import * as crypto from 'node:crypto';

type UpstreamKind = 'catalog' | 'staged';

type SyncQuery = Record<string, string | number | undefined>;

type SyncOptions = {
  includeExtraSearches?: boolean;
};

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

  private buildUrl(kind: UpstreamKind, query: SyncQuery = {}) {
    const base = this.upstreamBase();
    if (!base) return '';
    const path =
      kind === 'catalog'
        ? (process.env.UPSTREAM_CATALOG_PATH || '/catalog')
        : (process.env.UPSTREAM_STAGED_PATH || '/admin/staged');
    const rawUrl = /^https?:\/\//i.test(path)
      ? path
      : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    const url = new URL(rawUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
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

  private pickNumber(...vals: any[]) {
    for (const val of vals) {
      if (val === undefined || val === null || val === '') continue;
      const num = Number(val);
      if (Number.isFinite(num)) return num;
    }
    return null;
  }

  private paginationMeta(payload: any, itemsCount: number, fallbackPageSize: number) {
    const total = this.pickNumber(
      payload?.total,
      payload?.totalItems,
      payload?.count,
      payload?.meta?.total,
      payload?.pagination?.total,
      payload?.pageInfo?.total,
    );
    const pageSize = this.pickNumber(
      payload?.pageSize,
      payload?.limit,
      payload?.take,
      payload?.perPage,
      payload?.meta?.pageSize,
      payload?.meta?.limit,
      payload?.pagination?.pageSize,
      payload?.pagination?.limit,
    ) || fallbackPageSize;
    const hasNextRaw =
      payload?.hasNext ??
      payload?.has_next ??
      payload?.nextPage ??
      payload?.next_page ??
      payload?.next ??
      payload?.meta?.hasNext ??
      payload?.pagination?.hasNext ??
      payload?.pageInfo?.hasNextPage;
    const hasNext =
      typeof hasNextRaw === 'boolean'
        ? hasNextRaw
        : hasNextRaw === undefined || hasNextRaw === null
          ? null
          : Boolean(hasNextRaw);
    const hasPagination =
      total !== null ||
      hasNext !== null ||
      payload?.meta !== undefined ||
      payload?.pagination !== undefined ||
      payload?.pageInfo !== undefined;
    return { total, pageSize, hasNext, hasPagination, itemsCount };
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

  private sourceMeta(item: any) {
    const product = item?.product || item?.producto || item;
    const staged = item?.staged || item?.staged_product || item?.stage || null;
    const store =
      item?.store ||
      item?.shop ||
      item?.seller ||
      item?.vendor ||
      item?.merchant ||
      item?.tienda ||
      product?.store ||
      product?.shop ||
      product?.seller ||
      product?.vendor ||
      product?.merchant ||
      product?.tienda ||
      staged?.store ||
      staged?.shop ||
      staged?.seller ||
      staged?.vendor ||
      staged?.merchant ||
      staged?.tienda ||
      null;
    const storeName =
      typeof store === 'string'
        ? store
        : (store?.name || store?.title || store?.username || store?.slug || store?.id || null);
    const storeUrl =
      item?.store_url ||
      item?.shop_url ||
      item?.seller_url ||
      item?.url_store ||
      product?.store_url ||
      product?.shop_url ||
      product?.seller_url ||
      staged?.store_url ||
      staged?.shop_url ||
      staged?.seller_url ||
      (typeof store === 'object' ? (store?.url || store?.href || store?.link || null) : null);
    const sourceUrl =
      item?.source_url ||
      item?.sourceUrl ||
      item?.url ||
      item?.link ||
      product?.source_url ||
      product?.sourceUrl ||
      product?.url ||
      product?.link ||
      staged?.source_url ||
      staged?.sourceUrl ||
      staged?.url ||
      staged?.link ||
      null;
    return { storeName, storeUrl, sourceUrl };
  }

  private mergeNotes(baseNotes: any, item: any) {
    let parsed = baseNotes;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        parsed = { upstreamNotes: parsed };
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
    const product = item?.product || item?.producto || item || {};
    const staged = item?.staged || item?.staged_product || item?.stage || {};
    const specs = this.pickValue(staged?.specs, item?.specs, product?.specs, (parsed as any)?.specs, {}) as any;
    const battery = this.pickValue(staged?.bateria, item?.bateria, product?.bateria, specs?.bateria, (parsed as any)?.bateria, {}) as any;
    const batteryCycles = this.pickValue(staged?.battery_cycles, staged?.batteryCycles, item?.battery_cycles, item?.batteryCycles, product?.battery_cycles, product?.batteryCycles, battery?.ciclos, (parsed as any)?.batteryCycles);
    const batteryHealth = this.pickValue(staged?.battery_health, staged?.batteryHealth, item?.battery_health, item?.batteryHealth, product?.battery_health, product?.batteryHealth, battery?.salud, (parsed as any)?.batteryHealth);
    const color = this.pickValue(staged?.color, item?.color, product?.color, specs?.color, (parsed as any)?.color);
    const condition = this.pickValue(staged?.product_condition, staged?.productCondition, item?.product_condition, item?.productCondition, product?.product_condition, product?.productCondition, specs?.estado, (parsed as any)?.productCondition, (parsed as any)?.estado);
    const includes = this.pickValue(staged?.includes, item?.includes, product?.includes, specs?.includes, specs?.incluye, (parsed as any)?.includes);
    const includesExtra = this.pickValue(staged?.includes_extra, staged?.includesExtra, item?.includes_extra, item?.includesExtra, product?.includes_extra, product?.includesExtra, (parsed as any)?.includesExtra);
    const warrantyEnabled = this.pickValue(staged?.warrantyEnabled, staged?.garantiaActiva, item?.warrantyEnabled, item?.garantiaActiva, product?.warrantyEnabled, product?.garantiaActiva, specs?.warrantyEnabled, specs?.garantiaActiva, (parsed as any)?.warrantyEnabled, (parsed as any)?.garantiaActiva);
    const warrantyDate = this.pickValue(staged?.warrantyDate, staged?.garantiaFecha, staged?.garantia, item?.warrantyDate, item?.garantiaFecha, item?.garantia, product?.warrantyDate, product?.garantiaFecha, product?.garantia, specs?.garantiaFecha, specs?.garantia, (parsed as any)?.warrantyDate, (parsed as any)?.garantiaFecha, (parsed as any)?.garantia);
    parsed = {
      ...parsed,
      ...(color !== undefined ? { color } : {}),
      ...(condition !== undefined ? { productCondition: condition, estado: condition } : {}),
      ...(includes !== undefined ? { includes } : {}),
      ...(includesExtra !== undefined ? { includesExtra } : {}),
      ...(batteryCycles !== undefined || batteryHealth !== undefined ? {
        bateria: { ...((parsed as any).bateria || {}), ciclos: batteryCycles ?? (parsed as any)?.bateria?.ciclos ?? null, salud: batteryHealth ?? (parsed as any)?.bateria?.salud ?? null },
        batteryCycles: batteryCycles ?? (parsed as any)?.batteryCycles ?? null,
        batteryHealth: batteryHealth ?? (parsed as any)?.batteryHealth ?? null,
      } : {}),
      ...(warrantyEnabled !== undefined ? { warrantyEnabled, garantiaActiva: warrantyEnabled } : {}),
      ...(warrantyDate !== undefined ? { warrantyDate, garantiaFecha: warrantyDate, garantia: warrantyDate } : {}),
    };
    const meta = this.sourceMeta(item);
    if (!meta.storeName && !meta.storeUrl && !meta.sourceUrl) return this.normalizeNotes(parsed);
    return this.normalizeNotes({
      ...parsed,
      source: {
        ...(parsed as any).source,
        storeName: meta.storeName ?? (parsed as any).source?.storeName ?? null,
        storeUrl: meta.storeUrl ?? (parsed as any).source?.storeUrl ?? null,
        sourceUrl: meta.sourceUrl ?? (parsed as any).source?.sourceUrl ?? null,
      },
    });
  }

  private syncSearchTerms(kind: UpstreamKind, includeExtraSearches = false) {
    if (kind !== 'staged' || !includeExtraSearches) return [''];
    const raw = String(process.env.UPSTREAM_SYNC_SEARCH_TERMS || 'pawn,pawnshop,pawn shop').trim();
    const terms = raw
      .split(',')
      .map((term) => term.trim())
      .filter(Boolean);
    return Array.from(new Set(['', ...terms]));
  }

  private syncSearchRequests(kind: UpstreamKind, includeExtraSearches = false) {
    const terms = this.syncSearchTerms(kind, includeExtraSearches);
    const rawParams = String(process.env.UPSTREAM_SYNC_SEARCH_PARAMS || process.env.UPSTREAM_SYNC_SEARCH_PARAM || 'q,search,seller,store,shop,tienda');
    const params = Array.from(new Set(rawParams.split(',').map((param) => param.trim()).filter(Boolean)));
    const requests: Array<{ search: string; param?: string }> = [{ search: '' }];
    for (const search of terms.filter(Boolean)) {
      for (const param of params) requests.push({ search, param });
    }
    return requests;
  }

  private queryForSearch(page: number, pageSize: number, search: string, queryParam?: string): SyncQuery {
    return {
      page,
      pageSize,
      ...(search && queryParam ? { [queryParam]: search } : {}),
    };
  }

  private parseMaybeJson(value: any) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(String(value));
    } catch {
      return {};
    }
  }

  private normalizeSearchText(value: unknown) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}+/gu, '');
  }

  private addPawnStoreTerm(terms: Set<string>, value: unknown) {
    const raw = String(value || '').trim();
    if (!raw) return;
    const normalized = this.normalizeSearchText(raw);
    if (!normalized.includes('pawn')) return;
    if (normalized === 'pawn' || normalized === 'pawn shop' || normalized === 'pawnshop') return;
    terms.add(raw);
  }

  private addPawnTermsFromUrl(terms: Set<string>, value: unknown) {
    const raw = String(value || '').trim();
    if (!raw) return;
    try {
      const url = new URL(raw);
      const parts = [
        url.hostname.replace(/^www\./, '').split('.')[0],
        ...url.pathname.split('/').filter(Boolean),
      ];
      for (const part of parts) this.addPawnStoreTerm(terms, part.replace(/[-_]+/g, ' '));
    } catch {
      for (const match of raw.match(/[a-z0-9._-]*pawn[a-z0-9._-]*/gi) || []) {
        this.addPawnStoreTerm(terms, match.replace(/[-_]+/g, ' '));
      }
    }
  }

  private extractPawnStoreTermsFromNotes(notesRaw: any) {
    const terms = new Set<string>();
    const notes = this.parseMaybeJson(notesRaw);
    const source = notes?.source || {};
    const candidates = [
      source?.storeName,
      source?.store,
      source?.shop,
      source?.seller,
      source?.vendor,
      notes?.storeName,
      notes?.store,
      notes?.shop,
      notes?.seller,
      notes?.vendor,
      notes?.tienda,
    ];
    for (const candidate of candidates) this.addPawnStoreTerm(terms, candidate);
    this.addPawnTermsFromUrl(terms, source?.storeUrl || notes?.storeUrl || notes?.shopUrl || notes?.sellerUrl);
    this.addPawnTermsFromUrl(terms, source?.sourceUrl || notes?.sourceUrl || notes?.url || notes?.link);
    const raw = typeof notesRaw === 'string' ? notesRaw : JSON.stringify(notes || {});
    for (const match of raw.match(/[a-z0-9._-]*pawn[a-z0-9._-]*/gi) || []) {
      this.addPawnStoreTerm(terms, match.replace(/[-_]+/g, ' '));
    }
    return Array.from(terms);
  }

  private async savedPawnStoreTerms() {
    const rows = await this.staged.manager.query(`
      SELECT notes
      FROM staged_products
      WHERE COALESCE(notes, '') ILIKE '%pawn%'
      ORDER BY updated_at DESC
      LIMIT 1000
    `);
    const terms = new Set<string>();
    for (const row of rows || []) {
      for (const term of this.extractPawnStoreTermsFromNotes(row?.notes)) {
        terms.add(term);
      }
    }
    return Array.from(terms);
  }

  private previewSearchRequests(terms: string[]) {
    const rawParams = String(process.env.UPSTREAM_SYNC_SEARCH_PARAMS || process.env.UPSTREAM_SYNC_SEARCH_PARAM || 'q,search,seller,store,shop,tienda');
    const params = Array.from(new Set(rawParams.split(',').map((param) => param.trim()).filter(Boolean)));
    const requests: Array<{ search: string; param: string }> = [];
    for (const search of terms) {
      for (const param of params) requests.push({ search, param });
    }
    return requests;
  }

  private pickValue<T>(...vals: Array<T | undefined | null>): T | undefined {
    for (const v of vals) if (v !== undefined && v !== null && v !== '') return v as T;
    return undefined;
  }

  private itemKeys(item: any) {
    const product = item?.product || item?.producto || item;
    const staged = item?.staged || item?.staged_product || item?.stage || null;
    const rawSku = this.pickValue(product?.sku, staged?.sku, item?.sku);
    const sku = rawSku ? String(rawSku).trim().replace(/^svc(?=[-_\s]*\d)/i, 'MS') : rawSku;
    const sourceRaw = this.pickValue(staged?.source_id, item?.id, product?.id, sku);
    const sourceId = sourceRaw
      ? (/^[0-9a-f-]{36}$/i.test(String(sourceRaw)) ? String(sourceRaw) : this.toDeterministicUuid(String(sourceRaw)))
      : null;
    return {
      sku: sku ? String(sku) : null,
      sourceId,
    };
  }

  private async existsInLocalDb(item: any) {
    const { sku, sourceId } = this.itemKeys(item);
    if (sku) {
      const product = await this.products.findOne({ where: { sku } });
      if (product) return true;
    }
    if (sourceId) {
      const staged = await this.staged.findOne({ where: { source_id: sourceId } });
      if (staged) return true;
    }
    return false;
  }

  private stagedRowFromItem(item: any) {
    const product = item?.product || item?.producto || item;
    const staged = item?.staged || item?.staged_product || item?.stage || null;

    const { sku, sourceId } = this.itemKeys(item);
    if (!sku) return null;

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
    const batteryCycles = this.pickValue(staged?.battery_cycles, staged?.batteryCycles, item?.battery_cycles, item?.batteryCycles, product?.battery_cycles, product?.batteryCycles, staged?.bateria?.ciclos, item?.bateria?.ciclos, product?.bateria?.ciclos, product?.specs?.bateria?.ciclos, null) as any;
    const batteryHealth = this.pickValue(staged?.battery_health, staged?.batteryHealth, item?.battery_health, item?.batteryHealth, product?.battery_health, product?.batteryHealth, staged?.bateria?.salud, item?.bateria?.salud, product?.bateria?.salud, product?.specs?.bateria?.salud, null) as any;
    const color = this.pickValue(staged?.color, item?.color, product?.color, product?.specs?.color, null) as any;

    const category = this.pickValue(staged?.category, item?.category, product?.category, null) as any;
    const tags = this.normalizeArray(this.pickValue(staged?.tags, item?.tags, null));
    const images = Array.isArray(this.pickValue(staged?.images, item?.images, product?.images)) ? this.pickValue(staged?.images, item?.images, product?.images) : [];
    const notes = this.mergeNotes(this.pickValue(staged?.notes, item?.notes, null), item);
    const sourceRaw = this.pickValue(staged?.source_id, item?.id, product?.id, sku);

    return {
      id: sourceId || this.toDeterministicUuid(String(sourceRaw || sku)),
      source_id: sourceId || this.toDeterministicUuid(String(sourceRaw || sku)),
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
      battery_cycles: batteryCycles === null ? null : Number(batteryCycles),
      battery_health: batteryHealth === null ? null : Number(batteryHealth),
      color: color ?? null,
      includes: includes ?? null,
      includes_extra: includesExtra ?? null,
      keyboard_layout: keyboardLayout ?? null,
      product_condition: productCondition ?? null,
      category: category ? String(category) : null,
      tags,
      images: Array.isArray(images) ? images : [],
      notes,
      transient: true,
    };
  }

  private async upsertFromItem(item: any) {
    const row = this.stagedRowFromItem(item);
    if (!row) return;

    await this.products.upsert(
      {
        sku: row.sku,
        title: row.title,
        price: row.price,
        status: row.status,
        stock: row.stock,
        sale_type: asSaleType(row.sale_type ?? null),
        discount: row.discount ?? null,
        final_price: row.final_price ?? null,
        min_offer_price: row.min_offer_price ?? null,
        iphone_model: asIphoneModel(row.iphone_model ?? null),
        battery_cycles: Number.isFinite(row.battery_cycles) ? row.battery_cycles : null,
        battery_health: Number.isFinite(row.battery_health) ? row.battery_health : null,
        color: row.color,
        includes: asIncludesKind(row.includes ?? null),
        includes_extra: row.includes_extra ?? null,
        keyboard_layout: asKeyboardLayout(row.keyboard_layout ?? null),
        product_condition: asProductCondition(row.product_condition ?? null),
      },
      { conflictPaths: ['sku'] },
    );

    await this.staged.upsert(
      {
        source_id: row.source_id,
        sku: row.sku,
        title: row.title,
        price: row.price,
        status: row.status,
        stock: row.stock,
        sale_type: row.sale_type,
        discount: row.discount,
        final_price: row.final_price,
        min_offer_price: row.min_offer_price,
        iphone_model: row.iphone_model,
        battery_cycles: Number.isFinite(row.battery_cycles) ? row.battery_cycles : null,
        battery_health: Number.isFinite(row.battery_health) ? row.battery_health : null,
        color: row.color,
        includes: row.includes,
        includes_extra: row.includes_extra,
        keyboard_layout: row.keyboard_layout,
        product_condition: row.product_condition,
        category: row.category,
        tags: row.tags,
        images: row.images,
        notes: row.notes,
      },
      { conflictPaths: ['source_id'] },
    );
  }

  async sync(kind: UpstreamKind, options: SyncOptions = {}) {
    if (!this.syncOnReadEnabled()) return { ok: false, reason: 'disabled' };
    const pageSize = Math.max(1, Number(process.env.UPSTREAM_SYNC_PAGE_SIZE || 100) || 100);
    const maxPages = Math.max(1, Number(process.env.UPSTREAM_SYNC_MAX_PAGES || 100) || 100);
    const existingCutoff = Math.max(pageSize * 2, Number(process.env.UPSTREAM_SYNC_EXISTING_CUTOFF || 0) || 0);

    let count = 0;
    let pages = 0;
    let expectedTotal: number | null = null;
    let hitExisting = false;

    for (const searchRequest of this.syncSearchRequests(kind, Boolean(options.includeExtraSearches))) {
      let page = 1;
      let consecutiveExisting = 0;
      let termTotal: number | null = null;

      while (page <= maxPages) {
        const url = this.buildUrl(kind, this.queryForSearch(page, pageSize, searchRequest.search, searchRequest.param));
        if (!url) return { ok: false, reason: 'no_upstream' };

        const res = await fetch(url, { headers: this.headers() }).catch((e: unknown) => {
          this.logger.warn(`upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`);
          return null as any;
        });
        if (!res || !res.ok) {
          this.logger.warn(`upstream fetch failed: ${res?.status || 'no-response'} ${url}`);
          return page === 1 && pages === 0 ? { ok: false, reason: 'fetch_failed' } : { ok: true, count, pages, partial: true };
        }

        const payload = await res.json().catch(() => null);
        const items = this.extractItems(payload);
        const meta = this.paginationMeta(payload, items.length, pageSize);
        expectedTotal = meta.total ?? expectedTotal;
        termTotal = meta.total ?? termTotal;

        let pageCount = 0;
        for (const it of items) {
          try {
            const alreadyExists = await this.existsInLocalDb(it);
            await this.upsertFromItem(it);
            pageCount += 1;
            consecutiveExisting = alreadyExists ? consecutiveExisting + 1 : 0;
            if (consecutiveExisting >= existingCutoff) {
              hitExisting = true;
              break;
            }
          } catch (e: unknown) {
            this.logger.warn(`upsert failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        count += pageCount;
        pages += 1;

        if (hitExisting) break;
        if (!items.length) break;
        if (meta.hasNext === false) break;
        if (termTotal !== null && page * pageSize >= termTotal) break;
        if (meta.hasNext === true) {
          page += 1;
          continue;
        }
        if (items.length < meta.pageSize) break;
        page += 1;
      }

      hitExisting = false;
    }

    return { ok: true, count, pages, total: expectedTotal ?? undefined };
  }

  async previewStagedPawnSearch() {
    if (!this.syncOnReadEnabled()) return { ok: false, reason: 'disabled', items: [], total: 0 };
    const pageSize = Math.max(1, Number(process.env.UPSTREAM_SYNC_PAGE_SIZE || 100) || 100);
    const maxPages = Math.max(1, Number(process.env.UPSTREAM_SYNC_MAX_PAGES || 100) || 100);
    const storeTerms = await this.savedPawnStoreTerms();
    const byKey = new Map<string, any>();
    let pages = 0;

    if (!storeTerms.length) return { ok: true, items: [], total: 0, pages: 0, stores: 0 };

    for (const searchRequest of this.previewSearchRequests(storeTerms)) {
      let page = 1;
      let termTotal: number | null = null;

      while (page <= maxPages) {
        const url = this.buildUrl('staged', this.queryForSearch(page, pageSize, searchRequest.search, searchRequest.param));
        if (!url) return { ok: false, reason: 'no_upstream', items: [], total: 0 };

        const res = await fetch(url, { headers: this.headers() }).catch((e: unknown) => {
          this.logger.warn(`upstream preview fetch failed: ${e instanceof Error ? e.message : String(e)}`);
          return null as any;
        });
        if (!res || !res.ok) {
          this.logger.warn(`upstream preview fetch failed: ${res?.status || 'no-response'} ${url}`);
          break;
        }

        const payload = await res.json().catch(() => null);
        const items = this.extractItems(payload);
        const meta = this.paginationMeta(payload, items.length, pageSize);
        termTotal = meta.total ?? termTotal;

        for (const item of items) {
          const alreadyExists = await this.existsInLocalDb(item);
          if (alreadyExists) continue;
          const row = this.stagedRowFromItem(item);
          if (!row) continue;
          const key = row.sku || row.source_id || row.id;
          if (!byKey.has(key)) byKey.set(key, row);
        }

        pages += 1;
        if (!items.length) break;
        if (meta.hasNext === false) break;
        if (termTotal !== null && page * pageSize >= termTotal) break;
        if (meta.hasNext === true) {
          page += 1;
          continue;
        }
        if (items.length < meta.pageSize) break;
        page += 1;
      }
    }

    const items = Array.from(byKey.values());
    return { ok: true, items, total: items.length, pages, stores: storeTerms.length };
  }

  async syncCatalog() {
    return this.sync('catalog');
  }

  async syncStaged(options: SyncOptions = {}) {
    return this.sync('staged', options);
  }
}
