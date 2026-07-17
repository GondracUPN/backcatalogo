import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Put, Query, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike, In, Not } from 'typeorm';
import { randomUUID } from 'crypto';
import { StagedProduct } from '../../entities/staged-product.entity';
import { CatalogPublic } from '../../entities/catalog-public.entity';
import { CatalogProduct, IncludesKind, IphoneModel, KeyboardLayout, ProductCondition, SaleType } from '../../entities/catalog-product.entity';
import { CatalogView } from '../../entities/catalog-view.entity';
import { AuthService } from '../auth/auth.service';
import { PullSyncService } from '../sync/pull.service';
import { validateProductBeforePublish } from '../../utils/product-validation';

const SALE_TYPES = new Set(['PREVENTA', 'VENTA_SIMPLE', 'PROMOCION', 'OFERTA']);
const IPHONE_MODELS = new Set(['Normal', 'Plus', 'Pro', 'Pro Max', 'Mini', 'E']);
const INCLUDES_VALUES = new Set(['Caja + Cubo + Cable', 'Cubo + Cable', 'Solo Cable', 'Caja + Cable', 'Caja sola', 'Cable solo', 'Ninguno', 'Otros']);
const IPHONE_INCLUDES_VALUES = new Set(['Caja + Cable', 'Caja sola', 'Cable solo', 'Otros', 'Ninguno']);
const KEYBOARD_LAYOUTS = new Set(['Ingles', 'Espanol', 'Otro']);
const PRODUCT_CONDITIONS = new Set(['Nuevo', 'Usado', 'Open Box', 'Arreglado']);
const CATEGORIES = new Set(['macbook', 'ipad', 'iphone', 'watch', 'accesorios', 'otros']);
const PRODUCT_VERSION_CONFIG_KEY = 'product_versions';

function getAllowedIphoneModelsByNumber(numberRaw: unknown) {
  const map: Record<string, string[]> = {
    '11': ['Normal', 'Pro', 'Pro Max'],
    '12': ['Mini', 'Normal', 'Pro', 'Pro Max'],
    '13': ['Mini', 'Normal', 'Pro', 'Pro Max'],
    '14': ['Normal', 'Plus', 'Pro', 'Pro Max'],
    '15': ['Normal', 'Plus', 'Pro', 'Pro Max'],
    '16': ['Normal', 'Plus', 'Pro', 'Pro Max', 'E'],
    '17': ['Normal', 'Plus', 'Pro', 'Pro Max', 'E'],
  };
  return map[String(numberRaw ?? '')] || [];
}

function asSaleType(value: string): SaleType {
  return value as SaleType;
}

function asProductCondition(value: string | null): ProductCondition | null {
  return value as ProductCondition | null;
}

function asIphoneModel(value: string | null): IphoneModel | null {
  return value as IphoneModel | null;
}

function asIncludesKind(value: string | null): IncludesKind | null {
  return value as IncludesKind | null;
}

function asKeyboardLayout(value: string | null): KeyboardLayout | null {
  return value as KeyboardLayout | null;
}

function slugify(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function truthyQuery(value: unknown) {
  return ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(String(value || '').toLowerCase());
}

function parseNotes(value: unknown) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value || {};
  } catch {
    return {};
  }
}

function stringifyNotes(value: any) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return '{}';
  }
}

function normalizeMsSku(value: unknown) {
  const raw = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return '';
  if (/^MS-\d+$/.test(raw)) return raw;
  const number = raw.match(/\d+/)?.[0] || '';
  return number ? `MS-${number}` : raw;
}

function randomSkuToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

function manualSkuForSaleType(value: unknown, saleType: string) {
  const normalized = normalizeMsSku(value);
  if (normalized) return saleType === 'PREVENTA' ? `PREV-${normalized}` : normalized;
  return saleType === 'PREVENTA' ? `PREV-MS-${randomSkuToken()}` : `MS-${randomSkuToken()}`;
}

function promotionDiscountMode(notes: any, fallback?: unknown) {
  const raw = String(fallback ?? notes?.discountMode ?? notes?.discountType ?? 'percent').toLowerCase();
  return raw === 'amount' || raw === 'flat' || raw === 'soles' ? 'amount' : 'percent';
}

function promotionFinalPrice(price: number, discount: number, mode: string) {
  const computed = mode === 'amount' ? price - discount : price * (1 - discount / 100);
  return +Math.max(0, computed).toFixed(2);
}

function saleDateValue(value: unknown, fallback = new Date()) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00-05:00`)
    : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function analyticsCategoryRank(value: unknown) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '');
  const order: Record<string, number> = {
    macbook: 0,
    ipad: 1,
    ipads: 1,
    iphone: 2,
    iphones: 2,
    watch: 3,
    otros: 4,
    proximo: 5,
    proximos: 5,
    preventa: 5,
  };
  return order[key] ?? 99;
}

function analyticsDateIso(value: unknown) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function analyticsLastViewedDesc(a: { lastViewedAt?: unknown }, b: { lastViewedAt?: unknown }) {
  const aTime = Date.parse(String(a.lastViewedAt || ''));
  const bTime = Date.parse(String(b.lastViewedAt || ''));
  return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}

@Controller('admin')
export class AdminController {
  private soldRecordsReady: Promise<void> | null = null;

  constructor(
    private auth: AuthService,
    @InjectRepository(StagedProduct) private stagedRepo: Repository<StagedProduct>,
    @InjectRepository(CatalogPublic) private publicRepo: Repository<CatalogPublic>,
    @InjectRepository(CatalogProduct) private productRepo: Repository<CatalogProduct>,
    @InjectRepository(CatalogView) private viewRepo: Repository<CatalogView>,
    private pullSync: PullSyncService,
  ) {}

  private requireAdmin(authHeader?: string) {
    const token = (authHeader || '').startsWith('Bearer ') ? (authHeader || '').substring(7) : undefined;
    if (!token) throw new UnauthorizedException();
    const payload = this.auth.verifyToken(token);
    if (!payload || payload.role !== 'ADMIN') throw new UnauthorizedException();
    return payload;
  }

  private async ensureCartAvailable() {
    const rows = await this.productRepo.manager.query(`SELECT to_regclass('public.cart_items') as name`);
    if (!rows?.[0]?.name) throw new BadRequestException('cart not available');
  }

  private ensureSoldRecordsTable() {
    if (!this.soldRecordsReady) {
      const mgr = this.productRepo.manager;
      this.soldRecordsReady = (async () => {
        await mgr.query(`CREATE TABLE IF NOT EXISTS sold_records (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          product_id uuid NOT NULL,
          sku text,
          sale_price numeric(12,2) NOT NULL DEFAULT 0,
          sold_at timestamptz NOT NULL DEFAULT now(),
          created_at timestamptz NOT NULL DEFAULT now()
        )`);
        await mgr.query(`ALTER TABLE sold_records ADD COLUMN IF NOT EXISTS customer_name text NULL`);
        await mgr.query(`ALTER TABLE sold_records ADD COLUMN IF NOT EXISTS customer_phone text NULL`);
        await mgr.query(`ALTER TABLE sold_records ADD COLUMN IF NOT EXISTS customer_kind text NULL`);
        await mgr.query(`ALTER TABLE sold_records ADD COLUMN IF NOT EXISTS sale_place_type text NULL`);
        await mgr.query(`ALTER TABLE sold_records ADD COLUMN IF NOT EXISTS sale_location text NULL`);
      })().catch((error) => {
        this.soldRecordsReady = null;
        throw error;
      });
    }
    return this.soldRecordsReady;
  }

  private async ensureContactRequestsTable() {
    const mgr = this.productRepo.manager;
    await mgr.query(`CREATE TABLE IF NOT EXISTS contact_requests (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      cart_id text NOT NULL,
      request_type text NOT NULL DEFAULT 'purchase',
      product_id uuid NULL,
      product_title text NOT NULL,
      product_color text NULL,
      product_price numeric(12,2) NOT NULL DEFAULT 0,
      customer_name text NOT NULL,
      customer_phone text NOT NULL,
      location_scope text NOT NULL,
      location_value text NOT NULL,
      metadata jsonb NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  private async ensurePossibleClientsTable() {
    const mgr = this.productRepo.manager;
    await mgr.query(`CREATE TABLE IF NOT EXISTS possible_clients (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      source_request_id uuid NULL UNIQUE,
      cart_id text NULL,
      request_type text NULL,
      product_id uuid NULL,
      product_title text NULL,
      product_color text NULL,
      product_price numeric(12,2) NOT NULL DEFAULT 0,
      customer_name text NOT NULL,
      customer_phone text NOT NULL,
      location_scope text NULL,
      location_value text NULL,
      status text NOT NULL DEFAULT 'pending',
      customer_kind text NULL,
      sale_place_type text NULL,
      sale_location text NULL,
      metadata jsonb NULL,
      purchased_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await mgr.query(`CREATE INDEX IF NOT EXISTS idx_possible_clients_status ON possible_clients(status)`);
    await mgr.query(`CREATE INDEX IF NOT EXISTS idx_possible_clients_created_at ON possible_clients(created_at DESC)`);
  }

  private async ensureCatalogViewsTable() {
    await this.viewRepo.manager.query(`
      CREATE TABLE IF NOT EXISTS catalog_views (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        product_id uuid NOT NULL,
        product_slug text NOT NULL,
        product_title text NULL,
        category text NULL,
        session_id text NOT NULL,
        path text NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.viewRepo.manager.query(`CREATE INDEX IF NOT EXISTS idx_catalog_views_product_id ON catalog_views(product_id)`);
    await this.viewRepo.manager.query(`CREATE INDEX IF NOT EXISTS idx_catalog_views_category ON catalog_views(category)`);
    await this.viewRepo.manager.query(`CREATE INDEX IF NOT EXISTS idx_catalog_views_created_at ON catalog_views(created_at DESC)`);
    await this.viewRepo.manager.query(`CREATE INDEX IF NOT EXISTS idx_catalog_views_session_id ON catalog_views(session_id)`);
  }

  @Get('staged')
  async listStaged(
    @Headers('authorization') authHeader: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('pawnMode') pawnMode?: string,
    @Query('soloTiendasPawn') soloTiendasPawn?: string,
    @Query('savedPawnOnly') savedPawnOnly?: string,
  ) {
    this.requireAdmin(authHeader);
    const shouldSyncPawnStores = pawnMode === 'sync' || truthyQuery(soloTiendasPawn);
    const shouldReadSavedPawnOnly = pawnMode === 'saved' || truthyQuery(savedPawnOnly);
    try {
      if (!shouldReadSavedPawnOnly) {
        await this.pullSync.syncStaged({ includeExtraSearches: shouldSyncPawnStores });
      }
    } catch {}

    if (shouldReadSavedPawnOnly) {
      const preview = await this.pullSync.previewStagedPawnSearch();
      let items = preview.items || [];
      if (q) {
        const qLower = String(q).toLowerCase();
        items = items.filter((item: any) => String(item?.title || '').toLowerCase().includes(qLower));
      }
      if (status) {
        items = items.filter((item: any) => String(item?.status || '') === String(status));
      } else {
        const hiddenFromInventory = new Set(['published', 'hidden', 'sold']);
        items = items.filter((item: any) => !hiddenFromInventory.has(String(item?.status || '').toLowerCase()));
      }
      const total = items.length;
      const allRows = ['all', 'todos', '0', '-1'].includes(String(pageSize).toLowerCase());
      if (!allRows) {
        const take = Math.min(100, Math.max(1, parseInt(String(pageSize))));
        const safePage = Math.max(1, parseInt(String(page)));
        items = items.slice((safePage - 1) * take, safePage * take);
      }
      return { items, total };
    }

    const where: any = {};
    if (q) {
      const term = `%${String(q).trim()}%`;
      const query = this.stagedRepo
        .createQueryBuilder('staged')
        .where('(staged.title ILIKE :term OR staged.sku ILIKE :term)', { term });
      if (status) query.andWhere('staged.status = :status', { status });
      else query.andWhere('staged.status NOT IN (:...hidden)', { hidden: ['published', 'hidden', 'sold'] });
      query.orderBy('staged.updated_at', 'DESC');
      const allRows = ['all', 'todos', '0', '-1'].includes(String(pageSize).toLowerCase());
      if (!allRows) {
        const take = Math.min(100, Math.max(1, parseInt(String(pageSize))));
        query.take(take).skip((Math.max(1, parseInt(String(page))) - 1) * take);
      }
      const [items, total] = await query.getManyAndCount();
      return { items, total };
    }
    if (status) where.status = status;
    else where.status = Not(In(['published', 'hidden', 'sold'] as any) as any);
    const allRows = ['all', 'todos', '0', '-1'].includes(String(pageSize).toLowerCase());
    const options: any = { where, order: { updated_at: 'DESC' as any } };
    if (!allRows) {
      const take = Math.min(100, Math.max(1, parseInt(String(pageSize))));
      const skip = (Math.max(1, parseInt(String(page))) - 1) * take;
      options.take = take;
      options.skip = skip;
    }
    const [items, total] = await this.stagedRepo.findAndCount(options);
    return { items, total };
  }

  @Post('staged/manual')
  async createManualStaged(@Headers('authorization') authHeader: string, @Body() body: any) {
    this.requireAdmin(authHeader);

    const rawCategory = String(body?.category || 'otros').toLowerCase();
    const category = CATEGORIES.has(rawCategory) ? rawCategory : 'otros';
    const rawSaleType = String(body?.sale_type ?? body?.saleType ?? 'PREVENTA').toUpperCase();
    const saleType = SALE_TYPES.has(rawSaleType) ? rawSaleType : 'PREVENTA';
    const title = String(body?.title || 'Preventa').trim() || 'Preventa';

    const requestedSku = manualSkuForSaleType(body?.sku, saleType);
    let sku = requestedSku;
    for (let tries = 0; tries < 10; tries += 1) {
      const existingProduct = await this.productRepo.findOne({ where: { sku } });
      const existingStaged = await this.stagedRepo.findOne({ where: { sku } });
      if (!existingProduct && !existingStaged) break;
      if (body?.sku) throw new BadRequestException('SKU ya existe');
      sku = manualSkuForSaleType('', saleType);
      if (tries === 9) throw new BadRequestException('SKU no disponible');
    }

    const created = this.stagedRepo.create({
      source_id: randomUUID(),
      sku,
      title,
      price: String(Number(body?.price || 0) || 0),
      stock: Math.max(1, Number(body?.stock || 1) || 1),
      status: 'draft' as any,
      category,
      tags: null,
      images: Array.isArray(body?.images) ? body.images : [],
      notes: typeof body?.notes === 'string' ? body.notes : null,
      sale_type: saleType,
    });

    const item = await this.stagedRepo.save(created);
    return { ok: true, item };
  }

  @Put('staged/:id')
  async updateStaged(@Headers('authorization') authHeader: string, @Param('id') id: string, @Body() body: any) {
    this.requireAdmin(authHeader);
    const allowed = [
      'title',
      'price',
      'category',
      'tags',
      'notes',
      'images',
      'status',
      'stock',
      'iphone_model',
      'iphone_number',
      'storage_gb',
      'battery_cycles',
      'battery_health',
      'color',
      'includes',
      'includes_extra',
      'keyboard_layout',
      'variant_group',
      'sale_type',
      'discount',
      'final_price',
      'min_offer_price',
      'product_condition',
    ];
    const patch: any = {};
    for (const k of allowed) if (k in body) patch[k] = body[k];
    // map camelCase to snake_case
    if ('saleType' in body) patch.sale_type = body.saleType;
    if ('salePrice' in body) patch.price = body.salePrice;
    if ('iphoneModel' in body) patch.iphone_model = body.iphoneModel;
    if ('iphoneNumber' in body) patch.iphone_number = body.iphoneNumber;
    if ('storageGb' in body) patch.storage_gb = body.storageGb;
    if ('batteryCycles' in body) patch.battery_cycles = body.batteryCycles;
    if ('batteryHealth' in body) patch.battery_health = body.batteryHealth;
    if ('color' in body) patch.color = body.color;
    if ('includesExtra' in body) patch.includes_extra = body.includesExtra;
    if ('keyboardLayout' in body) patch.keyboard_layout = body.keyboardLayout;
    if ('variantGroup' in body) patch.variant_group = body.variantGroup;
    if ('finalPrice' in body) patch.final_price = body.finalPrice;
    if ('minOfferPrice' in body) patch.min_offer_price = body.minOfferPrice;
    if ('discount' in body) patch.discount = body.discount;
    if ('productCondition' in body) patch.product_condition = body.productCondition;

    const staged = await this.stagedRepo.findOne({ where: { id } });
    if (!staged) throw new BadRequestException('not found');

    const category = String(patch.category ?? staged.category ?? '').toLowerCase();
    const saleType = String(patch.sale_type ?? staged.sale_type ?? '').toUpperCase();
    const patchNotes = parseNotes(patch.notes ?? staged.notes);
    const iphoneModel = patch.iphone_model ?? staged.iphone_model;
    const iphoneNumber = patch.iphone_number ?? staged.iphone_number;
    const storageGb = patch.storage_gb ?? staged.storage_gb;
    const batteryHealth = patch.battery_health ?? staged.battery_health;
    const color = patch.color ?? staged.color;
    const includes = patch.includes ?? staged.includes;
    const includesExtra = patch.includes_extra ?? staged.includes_extra;
    const productCondition = patch.product_condition ?? staged.product_condition;

    if (saleType && !SALE_TYPES.has(saleType)) throw new BadRequestException('invalid sale_type');
    if (saleType) patch.sale_type = saleType;
    if (iphoneModel && !IPHONE_MODELS.has(String(iphoneModel))) throw new BadRequestException('invalid iphone_model');
    if (includes && !INCLUDES_VALUES.has(String(includes))) throw new BadRequestException('invalid includes');
    if (patch.keyboard_layout && !KEYBOARD_LAYOUTS.has(String(patch.keyboard_layout))) {
      throw new BadRequestException('invalid keyboard_layout');
    }
    if (productCondition && !PRODUCT_CONDITIONS.has(String(productCondition))) {
      throw new BadRequestException('invalid product_condition');
    }

    if (category === 'iphone') {
      if (!iphoneModel) throw new BadRequestException('iphone_model required');
      if (!iphoneNumber) throw new BadRequestException('iphone_number required');
      if (!storageGb) throw new BadRequestException('storage_gb required');
      if (saleType !== 'PREVENTA' && productCondition !== 'Nuevo' && (batteryHealth === undefined || batteryHealth === null || batteryHealth === '')) {
        throw new BadRequestException('battery_health required');
      }
      if (!color) throw new BadRequestException('color required');
      if (saleType !== 'PREVENTA' && productCondition !== 'Nuevo' && !includes) throw new BadRequestException('includes required');
      if (saleType !== 'PREVENTA' && productCondition !== 'Nuevo' && includes && !IPHONE_INCLUDES_VALUES.has(String(includes))) {
        throw new BadRequestException('includes invalid for iphone');
      }
      if (!isFinite(Number(iphoneNumber)) || Number(iphoneNumber) <= 0) {
        throw new BadRequestException('iphone_number invalid');
      }
      if (!isFinite(Number(storageGb)) || Number(storageGb) <= 0) {
        throw new BadRequestException('storage_gb invalid');
      }
      const allowedModels = getAllowedIphoneModelsByNumber(iphoneNumber);
      if (allowedModels.length && !allowedModels.includes(String(iphoneModel))) {
        throw new BadRequestException('iphone_model invalid for iphone_number');
      }
    }
    if (saleType !== 'PREVENTA' && productCondition !== 'Nuevo' && includes === 'Otros' && !includesExtra) {
      throw new BadRequestException('includes_extra required');
    }
    if (productCondition && productCondition !== 'Nuevo') {
      const stockNum = Number(patch.stock ?? staged.stock ?? 0);
      if (stockNum !== 1) throw new BadRequestException('stock must be 1 for condition');
    }
    if (saleType === 'PROMOCION') {
      const discount = patch.discount ?? staged.discount;
      if (discount === undefined || discount === null || discount === '') throw new BadRequestException('discount required');
      const price = Number(patch.price ?? staged.price ?? 0);
      const d = Number(discount || 0);
      const mode = promotionDiscountMode(patchNotes, body?.discountMode ?? body?.discountType);
      if (mode === 'percent' && d > 100) throw new BadRequestException('discount percent invalid');
      if (mode === 'amount' && d > price) throw new BadRequestException('discount amount greater than price');
      const finalPrice = promotionFinalPrice(price, d, mode);
      if (isFinite(finalPrice)) patch.final_price = String(finalPrice);
    }
    if (saleType === 'OFERTA') {
      const minOffer = patch.min_offer_price ?? staged.min_offer_price;
      if (minOffer === undefined || minOffer === null || minOffer === '') throw new BadRequestException('min_offer_price required');
      const price = Number(patch.price ?? staged.price ?? 0);
      const min = Number(minOffer || 0);
      if (price && min > price) throw new BadRequestException('min_offer_price greater than price');
    }
    if (saleType === 'PREVENTA' || saleType === 'VENTA_SIMPLE') {
      patch.discount = null;
      patch.final_price = null;
      patch.min_offer_price = null;
    }

    await this.stagedRepo.update({ id }, patch);
    return { ok: true };
  }

  @Post('staged/:id/delete')
  async deleteStaged(@Headers('authorization') authHeader: string, @Param('id') id: string) {
    this.requireAdmin(authHeader);
    const staged = await this.stagedRepo.findOne({ where: { id } });
    if (!staged) throw new BadRequestException('not found');
    if (String(staged.status || '').toLowerCase() === 'published') {
      throw new BadRequestException('cannot delete published staged');
    }
    await this.stagedRepo.delete({ id });
    return { ok: true };
  }

  @Post('staged/:id/publish')
  async publish(@Headers('authorization') authHeader: string, @Param('id') id: string, @Body() body: any) {
    this.requireAdmin(authHeader);
    const staged = await this.stagedRepo.findOne({ where: { id } });
    if (!staged) throw new BadRequestException('not found');
    const saleType = String(staged.sale_type || '').toUpperCase();
    await this.ensureCartAvailable();
    const validation = validateProductBeforePublish(staged);
    if (!validation.ok) throw new BadRequestException(validation.errors.join('; '));

    const salePrice = Number(staged.price ?? 0);
    const notes = parseNotes(staged.notes);
    let finalPrice = staged.final_price ? Number(staged.final_price) : null;
    if (saleType === 'PROMOCION') {
      const d = Number(staged.discount || 0);
      const computed = promotionFinalPrice(salePrice, d, promotionDiscountMode(notes));
      finalPrice = isFinite(computed) ? computed : null;
    }
    if (saleType === 'PREVENTA' || saleType === 'VENTA_SIMPLE') finalPrice = null;
    if (saleType === 'OFERTA') finalPrice = null;

    let publishTitle = String(staged.title || validation.autoTitle || '').trim();
    if (saleType === 'PREVENTA' && publishTitle && !/^preventa\s+/i.test(publishTitle)) {
      publishTitle = `Preventa ${publishTitle}`.trim();
    }
    if (publishTitle !== staged.title) {
      await this.stagedRepo.update({ id }, { title: publishTitle });
    }
    const effectiveVariantGroup = publishTitle;
    if (String(staged.variant_group || '').trim() !== effectiveVariantGroup) {
      await this.stagedRepo.update({ id }, { variant_group: effectiveVariantGroup });
    }
    const requestedSlug = String(body?.slug || '').trim();
    const baseSlug = slugify(requestedSlug || publishTitle);
    // 1) Asegurar que el producto principal tenga el precio final elegido
    await this.productRepo.upsert(
      {
        sku: staged.sku,
        title: publishTitle,
        price: String(salePrice ?? '0'),
        sale_type: asSaleType(saleType),
        discount: staged.discount || null,
        final_price: finalPrice !== null ? String(finalPrice) : null,
        min_offer_price: staged.min_offer_price || null,
        product_condition: asProductCondition(staged.product_condition || null),
        iphone_model: asIphoneModel(staged.iphone_model || null),
        iphone_number: staged.iphone_number ?? null,
        storage_gb: staged.storage_gb ?? null,
        battery_cycles: staged.battery_cycles ?? null,
        battery_health: staged.battery_health ?? null,
        color: staged.color ?? null,
        includes: asIncludesKind(staged.includes || null),
        includes_extra: staged.includes_extra || null,
        keyboard_layout: asKeyboardLayout(staged.keyboard_layout || null),
        variant_group: effectiveVariantGroup || null,
        status: 'listed' as any,
        stock: Number(staged.stock ?? 1),
      },
      { conflictPaths: ['sku'] },
    );
    const product = await this.productRepo.findOne({ where: { sku: staged.sku } });
    // 1.1) Resolver slug único (si ya existe para otro producto)
    let slug = baseSlug || 'producto';
    let tries = 1;
    while (true) {
      const existing = await this.publicRepo.findOne({ where: { slug } });
      if (!existing || existing.product_id === (product?.id || staged.source_id)) break;
      tries += 1;
      slug = `${baseSlug}-${tries}`;
      if (tries > 100) throw new BadRequestException('slug already in use');
    }
    // 2) Publicar apuntando al ID real del producto
    const pub = await this.publicRepo.upsert(
      {
        product_id: product?.id || staged.source_id,
        slug,
        is_published: true,
        category: staged.category || null,
        tags: staged.tags || null,
        images: staged.images || [],
      },
      { conflictPaths: ['product_id'] },
    );
    // Marcar staged como publicado para ocultarlo del inventario
    await this.stagedRepo.update({ id }, { status: 'published' as any, title: publishTitle, variant_group: effectiveVariantGroup || null });
    const mergeIds = Array.isArray(body?.mergeStagedIds)
      ? body.mergeStagedIds.map((value: unknown) => String(value || '').trim()).filter(Boolean).filter((value: string) => value !== id)
      : [];
    const mainSkuKey = String(staged.sku || '').trim().toLowerCase();
    const mergeSkus = Array.isArray(body?.mergeStagedSkus)
      ? body.mergeStagedSkus
          .map((value: unknown) => String(value || '').trim())
          .filter(Boolean)
          .filter((value: string) => value.toLowerCase() !== mainSkuKey)
      : [];
    const mergeSkuKeys = Array.from(new Set(mergeSkus.map((sku: string) => sku.toLowerCase())));
    const mergeRowsBySku = mergeSkuKeys.length
      ? await this.stagedRepo
          .createQueryBuilder('staged')
          .where('LOWER(staged.sku) IN (:...skus)', { skus: mergeSkuKeys })
          .getMany()
      : [];
    const foundSkuKeys = new Set(mergeRowsBySku.map((row) => String(row.sku || '').trim().toLowerCase()));
    const missingSkus = mergeSkus.filter((sku: string) => !foundSkuKeys.has(sku.toLowerCase()));
    if (missingSkus.length) throw new BadRequestException(`sku not found: ${missingSkus.join(', ')}`);
    const allMergeIds = Array.from(new Set([
      ...mergeIds,
      ...mergeRowsBySku.map((row) => row.id),
    ].filter((value) => value && value !== id)));
    const mergeRowsById = mergeIds.length ? await this.stagedRepo.findBy({ id: In(mergeIds) }) : [];
    const allMergeRows = Array.from(
      new Map([...mergeRowsById, ...mergeRowsBySku].map((row) => [row.id, row])).values(),
    ).filter((row) => row.id !== id);
    if (allMergeRows.length) {
      const linkedSkus = allMergeRows.map((row) => String(row.sku || '').trim()).filter(Boolean);
      const mainNotes = parseNotes(staged.notes);
      await this.stagedRepo.update(
        { id },
        {
          notes: stringifyNotes({
            ...(mainNotes || {}),
            linkedSkus,
            linkedSkuGroup: {
              mainSku: staged.sku,
              skus: linkedSkus,
            },
          }),
        },
      );
      for (const row of allMergeRows) {
        const rowNotes = parseNotes(row.notes);
        await this.stagedRepo.update(
          { id: row.id },
          {
            notes: stringifyNotes({
              ...(rowNotes || {}),
              linkedMainSku: staged.sku,
              linkedMainTitle: publishTitle,
              linkedSkuGroup: {
                mainSku: staged.sku,
              },
            }),
          },
        );
      }
    }
    if (allMergeIds.length) {
      await this.stagedRepo.update({ id: In(allMergeIds) }, { status: 'published' as any, title: publishTitle });
    }
    return { ok: true, result: pub.identifiers?.[0], warnings: validation.warnings };
  }

  @Get('catalog')
  async listAdminCatalog(@Headers('authorization') authHeader: string) {
    this.requireAdmin(authHeader);
    const publishedRows = await this.publicRepo.find({
      where: { is_published: true as any },
      order: { sort_order: 'ASC' as any, created_at: 'DESC' as any },
      take: 500,
    });
    const publishedRank = new Map(publishedRows.map((pub, index) => [pub.product_id, index] as const));
    const productIds = publishedRows.map((pub) => pub.product_id);
    const products = productIds.length ? await this.productRepo.findBy({ id: In(productIds) }) : [];
    const skus = products.map((p) => p.sku).filter(Boolean);
    const pubs = publishedRows;
    const stagedRows = skus.length ? await this.stagedRepo.findBy({ sku: In(skus) }) : [];
    const linkedRowsSource = skus.length
      ? await this.stagedRepo.find({
          where: { status: 'published' as any },
          order: { updated_at: 'DESC' as any },
          take: 1000,
        })
      : [];
    const skuSet = new Set(skus);
    const linkedRows = linkedRowsSource.filter((row) => {
      const linkedNotes = parseNotes(row.notes);
      return skuSet.has(String(linkedNotes?.linkedMainSku || '').trim());
    });
    const publishedStagedWithoutProduct = linkedRowsSource.filter((row) => !skuSet.has(String(row.sku || '').trim()));
    const pubByProduct = new Map(pubs.map((p) => [p.product_id, p] as const));
    const stagedBySku = new Map(stagedRows.map((s) => [s.sku, s] as const));
    const linkedByMainSku = new Map<string, StagedProduct[]>();
    for (const linked of linkedRows) {
      const linkedNotes = parseNotes(linked.notes);
      const mainSku = String(linkedNotes?.linkedMainSku || '').trim();
      if (!mainSku) continue;
      linkedByMainSku.set(mainSku, [...(linkedByMainSku.get(mainSku) || []), linked]);
    }
    const childSkuKeys = new Set<string>();
    for (const stagedRow of [...stagedRows, ...linkedRowsSource]) {
      const rowNotes = parseNotes(stagedRow.notes);
      if (rowNotes?.linkedMainSku) childSkuKeys.add(String(stagedRow.sku || '').trim().toLowerCase());
      const linkedSkus = Array.isArray(rowNotes?.linkedSkus) ? rowNotes.linkedSkus : [];
      linkedSkus.forEach((sku: unknown) => {
        const key = String(sku || '').trim().toLowerCase();
        if (key) childSkuKeys.add(key);
      });
    }
    const normalizeTitle = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const fallbackLinkedByTitle = new Map<string, StagedProduct[]>();
    for (const linked of publishedStagedWithoutProduct) {
      const linkedNotes = parseNotes(linked.notes);
      if (linkedNotes?.linkedMainSku) continue;
      const key = normalizeTitle(linked.title);
      if (!key) continue;
      fallbackLinkedByTitle.set(key, [...(fallbackLinkedByTitle.get(key) || []), linked]);
    }

    const items = products
      .filter((product) => product.status !== 'sold')
      .filter((product) => !childSkuKeys.has(String(product.sku || '').trim().toLowerCase()))
      .filter((product) => {
        const pub = pubByProduct.get(product.id);
        const staged = stagedBySku.get(product.sku);
        return Boolean(pub?.is_published) || (!pub && String(staged?.status || '').toLowerCase() === 'published');
      })
      .map((product) => {
        const pub = pubByProduct.get(product.id);
        const staged = stagedBySku.get(product.sku) || null;
        const linkedExplicit = linkedByMainSku.get(product.sku) || [];
        const linkedFallback = linkedExplicit.length ? [] : (fallbackLinkedByTitle.get(normalizeTitle(product.title)) || []);
        return {
          id: pub?.id || product.id,
          product_id: product.id,
          slug: pub?.slug || null,
          is_published: Boolean(pub?.is_published),
          category: pub?.category || staged?.category || null,
          created_at: pub?.created_at || product.created_at,
          updated_at: pub?.updated_at || product.updated_at,
          images: pub?.images || staged?.images || [],
          product,
          staged,
          linkedStaged: [...linkedExplicit, ...linkedFallback],
        };
      })
      .sort((a, b) => (publishedRank.get(a.product_id) ?? 999999) - (publishedRank.get(b.product_id) ?? 999999));

    return { items };
  }

  private async ensureCatalogSettingsTable() {
    await this.productRepo.manager.query(`
      CREATE TABLE IF NOT EXISTS catalog_settings (
        key text PRIMARY KEY,
        value jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  @Get('product-versions')
  async getProductVersions(@Headers('authorization') authHeader: string) {
    this.requireAdmin(authHeader);
    await this.ensureCatalogSettingsTable();
    const rows = await this.productRepo.manager.query(
      `SELECT value FROM catalog_settings WHERE key = $1 LIMIT 1`,
      [PRODUCT_VERSION_CONFIG_KEY],
    );
    return { ok: true, config: rows?.[0]?.value || {} };
  }

  @Post('product-versions')
  async saveProductVersions(@Headers('authorization') authHeader: string, @Body() body: any) {
    this.requireAdmin(authHeader);
    const config = body?.config && typeof body.config === 'object' ? body.config : {};
    await this.ensureCatalogSettingsTable();
    const rows = await this.productRepo.manager.query(
      `
        INSERT INTO catalog_settings (key, value, created_at, updated_at)
        VALUES ($1, $2::jsonb, now(), now())
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        RETURNING value
      `,
      [PRODUCT_VERSION_CONFIG_KEY, JSON.stringify(config)],
    );
    return { ok: true, config: rows?.[0]?.value || config };
  }

  @Post('staged/bulk')
  async bulk(@Headers('authorization') authHeader: string, @Body() body: any) {
    this.requireAdmin(authHeader);
    const { ids, action } = body || {};
    if (!Array.isArray(ids) || !action) throw new BadRequestException('invalid body');
    if (action === 'unpublish') {
      await this.publicRepo.update(ids.map((id: string) => ({ product_id: id })), { is_published: false });
    }
    if (action === 'publish') {
      await this.ensureCartAvailable();
      const items = await this.stagedRepo.findByIds(ids);
      for (const s of items) {
        const saleType = String(s.sale_type || '').toUpperCase();
        const validation = validateProductBeforePublish(s);
        if (!validation.ok) throw new BadRequestException(validation.errors.join('; '));

        const salePrice = Number(s.price ?? 0);
        const notes = parseNotes(s.notes);
        let finalPrice: number | null = s.final_price ? Number(s.final_price) : null;
        if (saleType === 'PROMOCION') {
          const d = Number(s.discount || 0);
          const computed = promotionFinalPrice(salePrice, d, promotionDiscountMode(notes));
          finalPrice = isFinite(computed) ? computed : null;
        }
        if (saleType === 'PREVENTA' || saleType === 'VENTA_SIMPLE' || saleType === 'OFERTA') finalPrice = null;

        let publishTitle = String(s.title || validation.autoTitle || '').trim();
        if (saleType === 'PREVENTA' && publishTitle && !/^preventa\s+/i.test(publishTitle)) {
          publishTitle = `Preventa ${publishTitle}`.trim();
        }
        await this.productRepo.upsert(
          {
            sku: s.sku,
            title: publishTitle,
            price: String(salePrice ?? '0'),
            sale_type: asSaleType(saleType),
            discount: s.discount || null,
            final_price: finalPrice !== null ? String(finalPrice) : null,
            min_offer_price: s.min_offer_price || null,
            product_condition: asProductCondition(s.product_condition || null),
            iphone_model: asIphoneModel(s.iphone_model || null),
            iphone_number: s.iphone_number ?? null,
            storage_gb: s.storage_gb ?? null,
            battery_cycles: s.battery_cycles ?? null,
            battery_health: s.battery_health ?? null,
            color: s.color ?? null,
            includes: asIncludesKind(s.includes || null),
            includes_extra: s.includes_extra || null,
            keyboard_layout: asKeyboardLayout(s.keyboard_layout || null),
            variant_group: s.variant_group || null,
            status: 'listed' as any,
            stock: Number(s.stock ?? 1),
          },
          { conflictPaths: ['sku'] },
        );
        const product = await this.productRepo.findOne({ where: { sku: s.sku } });
        const baseSlug = slugify(publishTitle);
        // Resolver slug único por cada item
        let slug = baseSlug || 'producto';
        let tries = 1;
        while (true) {
          const existing = await this.publicRepo.findOne({ where: { slug } });
          if (!existing || existing.product_id === (product?.id || s.source_id)) break;
          tries += 1;
          slug = `${baseSlug}-${tries}`;
          if (tries > 100) throw new BadRequestException('slug already in use');
        }
        await this.publicRepo.upsert(
          { product_id: product?.id || s.source_id, slug, is_published: true, category: s.category || null, tags: s.tags || null, images: s.images || [] },
          { conflictPaths: ['product_id'] },
        );
        await this.stagedRepo.update({ id: s.id }, { status: 'published' as any, title: publishTitle });
      }
    }
    return { ok: true };
  }

  @Post('public/:productId/unpublish')
  async unpublishOne(@Headers('authorization') authHeader: string, @Param('productId') productId: string) {
    this.requireAdmin(authHeader);
    // 1) Despublicar en tabla pública
    await this.publicRepo.update({ product_id: productId }, { is_published: false });
    // 2) Intentar marcar staged como 'draft' usando SKU del producto
    const prod = await this.productRepo.findOne({ where: { id: productId } });
    if (prod?.sku) {
      const staged = await this.stagedRepo.findOne({ where: { sku: prod.sku } });
      if (staged) await this.stagedRepo.update({ id: staged.id }, { status: 'draft' as any });
    }
    return { ok: true };
  }

  @Post('public/:productId/replace-preventa')
  async replacePreventa(
    @Headers('authorization') authHeader: string,
    @Param('productId') productId: string,
    @Body() body: any,
  ) {
    this.requireAdmin(authHeader);
    await this.ensureCartAvailable();

    const replacementStagedId = String(body?.stagedId || body?.replacementStagedId || '').trim();
    if (!replacementStagedId) throw new BadRequestException('replacement staged required');

    const currentProduct = await this.productRepo.findOne({ where: { id: productId } });
    if (!currentProduct) throw new BadRequestException('product not found');
    const currentPublic = await this.publicRepo.findOne({ where: { product_id: productId } });
    if (!currentPublic || !currentPublic.is_published) throw new BadRequestException('published product not found');

    const currentStaged = currentProduct.sku
      ? await this.stagedRepo.findOne({ where: { sku: currentProduct.sku } })
      : null;
    const currentSaleType = String(currentStaged?.sale_type || currentProduct.sale_type || '').toUpperCase();
    if (currentSaleType !== 'PREVENTA') throw new BadRequestException('product is not preventa');

    const replacement = await this.stagedRepo.findOne({ where: { id: replacementStagedId } });
    if (!replacement) throw new BadRequestException('replacement not found');
    if (String(replacement.id) === String(currentStaged?.id || '')) {
      throw new BadRequestException('replacement must be different');
    }
    if (['published', 'sold'].includes(String(replacement.status || '').toLowerCase())) {
      throw new BadRequestException('replacement is not available');
    }

    const currentNotesForMerge = parseNotes(currentStaged?.notes);
    const replacementNotesForMerge = parseNotes(replacement.notes);
    const firstFilled = (...values: unknown[]) => {
      for (const value of values) {
        if (value !== undefined && value !== null && String(value).trim() !== '') return value;
      }
      return null;
    };
    const firstValidProductCondition = (...values: unknown[]) => {
      for (const value of values) {
        const raw = String(value ?? '').trim();
        if (PRODUCT_CONDITIONS.has(raw)) return raw;
      }
      return '';
    };
    const mergedBatteryCycles = firstFilled(
      replacement.battery_cycles,
      currentStaged?.battery_cycles,
      replacementNotesForMerge?.batteryCycles,
      currentNotesForMerge?.batteryCycles,
      replacementNotesForMerge?.bateria?.ciclos,
      currentNotesForMerge?.bateria?.ciclos,
    );
    const mergedBatteryHealth = firstFilled(
      replacement.battery_health,
      currentStaged?.battery_health,
      replacementNotesForMerge?.batteryHealth,
      currentNotesForMerge?.batteryHealth,
      replacementNotesForMerge?.bateria?.salud,
      currentNotesForMerge?.bateria?.salud,
    );
    const mergedIncludes = firstFilled(replacement.includes, currentStaged?.includes, replacementNotesForMerge?.includes, currentNotesForMerge?.includes);
    let mergedProductCondition = firstValidProductCondition(
      replacement.product_condition,
      currentStaged?.product_condition,
      replacementNotesForMerge?.productCondition,
      currentNotesForMerge?.productCondition,
      replacementNotesForMerge?.estado,
      currentNotesForMerge?.estado,
      replacementNotesForMerge?.specs?.estado,
      currentNotesForMerge?.specs?.estado,
    ) || 'Nuevo';
    if (mergedProductCondition !== 'Nuevo' && (!mergedBatteryHealth || !mergedIncludes)) {
      mergedProductCondition = 'Nuevo';
    }
    const mergedDetail = {
      ...(currentNotesForMerge?.specs?.detalle || {}),
      ...(currentNotesForMerge?.detalle || {}),
      ...(replacementNotesForMerge?.specs?.detalle || {}),
      ...(replacementNotesForMerge?.detalle || {}),
    };
    const mergedSpecs = {
      ...(currentNotesForMerge?.specs || {}),
      ...(replacementNotesForMerge?.specs || {}),
      detalle: mergedDetail,
    };
    const mergedNotes = {
      ...(currentNotesForMerge || {}),
      ...(replacementNotesForMerge || {}),
      specs: {
        ...mergedSpecs,
        estado: mergedProductCondition,
      },
      detalle: mergedDetail,
      productCondition: mergedProductCondition,
      estado: mergedProductCondition,
      batteryCycles: mergedBatteryCycles,
      batteryHealth: mergedBatteryHealth,
      bateria: { ...(currentNotesForMerge?.bateria || {}), ...(replacementNotesForMerge?.bateria || {}), ciclos: mergedBatteryCycles, salud: mergedBatteryHealth },
      includes: mergedIncludes,
      saleType: null,
      preventaDateFrom: null,
      preventaDateTo: null,
      preventa: null,
      replacedPreventaProductId: productId,
      replacedPreventaSku: currentProduct.sku,
    };
    const mergedImages = (Array.isArray(replacement.images) && replacement.images.length)
      ? replacement.images
      : ((Array.isArray(currentPublic.images) && currentPublic.images.length)
        ? currentPublic.images
        : (Array.isArray(currentStaged?.images) ? currentStaged.images : []));
    const replacementSaleTypeRaw = String(replacement.sale_type || '').toUpperCase();
    const replacementSaleType = SALE_TYPES.has(replacementSaleTypeRaw) && replacementSaleTypeRaw !== 'PREVENTA'
      ? replacementSaleTypeRaw
      : 'VENTA_SIMPLE';
    const replacementTitle = String(firstFilled(replacement.title, currentProduct.title, currentStaged?.title) || '')
      .replace(/^preventa\s+/i, '')
      .trim();
    const stagedForValidation = {
      ...replacement,
      category: firstFilled(replacement.category, currentStaged?.category) as any,
      title: replacementTitle || replacement.title,
      sale_type: replacementSaleType,
      product_condition: mergedProductCondition as any,
      iphone_model: firstFilled(replacement.iphone_model, currentStaged?.iphone_model, replacementNotesForMerge?.iphoneModel, currentNotesForMerge?.iphoneModel) as any,
      iphone_number: firstFilled(replacement.iphone_number, currentStaged?.iphone_number, replacementNotesForMerge?.iphoneNumber, currentNotesForMerge?.iphoneNumber) as any,
      storage_gb: firstFilled(replacement.storage_gb, currentStaged?.storage_gb, replacementNotesForMerge?.storageGb, currentNotesForMerge?.storageGb, replacementNotesForMerge?.storage, currentNotesForMerge?.storage) as any,
      battery_cycles: mergedBatteryCycles as any,
      battery_health: mergedBatteryHealth as any,
      color: firstFilled(replacement.color, currentStaged?.color, replacementNotesForMerge?.color, currentNotesForMerge?.color) as any,
      includes: mergedIncludes as any,
      includes_extra: firstFilled(replacement.includes_extra, currentStaged?.includes_extra, replacementNotesForMerge?.includesExtra, currentNotesForMerge?.includesExtra) as any,
      keyboard_layout: firstFilled(replacement.keyboard_layout, currentStaged?.keyboard_layout) as any,
      variant_group: firstFilled(replacement.variant_group, currentStaged?.variant_group, replacementNotesForMerge?.variantGroup, currentNotesForMerge?.variantGroup) as any,
      images: mergedImages,
      notes: stringifyNotes(mergedNotes),
    } as StagedProduct;
    const validation = validateProductBeforePublish(stagedForValidation);
    if (!validation.ok) throw new BadRequestException(validation.errors.join('; '));

    const salePrice = Number(firstFilled(currentProduct.price, currentStaged?.price, replacement.price, 0) ?? 0);
    const notes = parseNotes(stagedForValidation.notes);
    let finalPrice = replacement.final_price ? Number(replacement.final_price) : null;
    if (replacementSaleType === 'PROMOCION') {
      const d = Number(replacement.discount || 0);
      const computed = promotionFinalPrice(salePrice, d, promotionDiscountMode(notes));
      finalPrice = isFinite(computed) ? computed : null;
    }
    if (replacementSaleType === 'VENTA_SIMPLE' || replacementSaleType === 'OFERTA') finalPrice = null;

    await this.productRepo.upsert(
      {
        sku: replacement.sku,
        title: replacementTitle || replacement.title,
        price: String(salePrice ?? '0'),
        sale_type: asSaleType(replacementSaleType),
        discount: replacementSaleType === 'PROMOCION' ? replacement.discount || null : null,
        final_price: finalPrice !== null ? String(finalPrice) : null,
        min_offer_price: replacementSaleType === 'OFERTA' ? replacement.min_offer_price || null : null,
        product_condition: asProductCondition(stagedForValidation.product_condition || null),
        iphone_model: asIphoneModel(stagedForValidation.iphone_model || null),
        iphone_number: stagedForValidation.iphone_number ?? null,
        storage_gb: stagedForValidation.storage_gb ?? null,
        battery_cycles: stagedForValidation.battery_cycles ?? null,
        battery_health: stagedForValidation.battery_health ?? null,
        color: stagedForValidation.color ?? null,
        includes: asIncludesKind(stagedForValidation.includes || null),
        includes_extra: stagedForValidation.includes_extra || null,
        keyboard_layout: asKeyboardLayout(stagedForValidation.keyboard_layout || null),
        variant_group: stagedForValidation.variant_group || null,
        status: 'listed' as any,
        stock: Number(stagedForValidation.stock ?? 1),
      },
      { conflictPaths: ['sku'] },
    );
    const replacementProduct = await this.productRepo.findOne({ where: { sku: replacement.sku } });
    if (!replacementProduct) throw new BadRequestException('replacement product not created');

    const requestedSlug = String(body?.slug || '').trim();
    const baseSlug = slugify(requestedSlug || replacementTitle || replacement.title);
    let slug = baseSlug || 'producto';
    let tries = 1;
    while (true) {
      const existing = await this.publicRepo.findOne({ where: { slug } });
      if (!existing || existing.id === currentPublic.id || existing.product_id === replacementProduct.id) break;
      tries += 1;
      slug = `${baseSlug}-${tries}`;
      if (tries > 100) throw new BadRequestException('slug already in use');
    }

    const existingReplacementPublic = await this.publicRepo.findOne({ where: { product_id: replacementProduct.id } });
    if (existingReplacementPublic && existingReplacementPublic.id !== currentPublic.id) {
      await this.publicRepo.delete({ id: existingReplacementPublic.id });
    }
    await this.publicRepo.manager.query(
      `
      UPDATE catalog_public
      SET product_id = $1,
          slug = $2,
          is_published = true,
          category = $3,
          tags = $4,
          images = $5::jsonb,
          created_at = now(),
          updated_at = now()
      WHERE id = $6
      `,
      [
        replacementProduct.id,
        slug,
        stagedForValidation.category || currentPublic.category || null,
        replacement.tags || currentStaged?.tags || null,
        JSON.stringify(mergedImages || []),
        currentPublic.id,
      ],
    );

    await this.stagedRepo.update(
      { id: replacement.id },
      {
        status: 'published' as any,
        title: replacementTitle || replacement.title,
        price: String(salePrice ?? '0'),
        sale_type: replacementSaleType,
        category: stagedForValidation.category || replacement.category || null,
        images: mergedImages,
        product_condition: stagedForValidation.product_condition || null,
        iphone_model: stagedForValidation.iphone_model || null,
        iphone_number: stagedForValidation.iphone_number ?? null,
        storage_gb: stagedForValidation.storage_gb ?? null,
        battery_cycles: stagedForValidation.battery_cycles ?? null,
        battery_health: stagedForValidation.battery_health ?? null,
        color: stagedForValidation.color || null,
        includes: stagedForValidation.includes || null,
        includes_extra: stagedForValidation.includes_extra || null,
        keyboard_layout: stagedForValidation.keyboard_layout || null,
        variant_group: stagedForValidation.variant_group || null,
        notes: stagedForValidation.notes,
      },
    );
    await this.productRepo.update({ id: currentProduct.id }, { status: 'hidden' as any, stock: 0 });
    if (currentStaged) {
      await this.stagedRepo.delete({ id: currentStaged.id });
    }

    return { ok: true, productId: replacementProduct.id, slug };
  }

  @Post('public/:productId/sold')
  async markSold(
    @Headers('authorization') authHeader: string,
    @Param('productId') productId: string,
    @Body() body?: any,
  ) {
    this.requireAdmin(authHeader);
    const product = await this.productRepo.findOne({ where: { id: productId } });
    if (!product) throw new BadRequestException('product not found');
    // Marcar el producto como vendido (se acepta fecha en body pero no se persiste aún)
    const currentStock = Math.max(0, Number(product.stock || 0));
    if (product.status === 'sold' || currentStock <= 0) throw new BadRequestException('product out of stock');

    const mainStaged = product.sku ? await this.stagedRepo.findOne({ where: { sku: product.sku } }) : null;
    const mainNotes = parseNotes(mainStaged?.notes);
    const linkedSkusFromMain = Array.isArray(mainNotes?.linkedSkus)
      ? mainNotes.linkedSkus.map((value: unknown) => String(value || '').trim()).filter(Boolean)
      : [];
    const allPublishedStaged = await this.stagedRepo.find({
      where: { status: 'published' as any },
      order: { updated_at: 'DESC' as any },
      take: 1000,
    });
    const availableLinked = allPublishedStaged.filter((row) => {
      const rowSku = String(row.sku || '').trim();
      const rowNotes = parseNotes(row.notes);
      return rowSku !== product.sku && (
        String(rowNotes?.linkedMainSku || '').trim() === product.sku ||
        linkedSkusFromMain.some((sku: string) => sku.toLowerCase() === rowSku.toLowerCase())
      );
    });
    const soldLinked = availableLinked[0] || null;
    const soldUnitSku = soldLinked?.sku || product.sku || '';
    const nextStock = Math.max(0, currentStock - 1);
    await this.productRepo.update(
      { id: productId },
      {
        stock: nextStock,
        status: nextStock <= 0 ? ('sold' as any) : ('listed' as any),
      },
    );
    if (soldLinked) {
      await this.stagedRepo.update({ id: soldLinked.id }, { status: 'sold' as any });
      await this.productRepo.update({ sku: soldLinked.sku }, { status: 'sold' as any, stock: 0 });
      if (mainStaged) {
        const updatedMainNotes = parseNotes(mainStaged.notes);
        const remainingLinkedSkus = (Array.isArray(updatedMainNotes?.linkedSkus) ? updatedMainNotes.linkedSkus : [])
          .map((value: unknown) => String(value || '').trim())
          .filter((sku: string) => sku && sku.toLowerCase() !== String(soldLinked.sku || '').trim().toLowerCase());
        await this.stagedRepo.update(
          { id: mainStaged.id },
          {
            notes: stringifyNotes({
              ...(updatedMainNotes || {}),
              linkedSkus: remainingLinkedSkus,
              linkedSkuGroup: {
                ...(updatedMainNotes?.linkedSkuGroup || {}),
                mainSku: product.sku,
                skus: remainingLinkedSkus,
              },
            }),
          },
        );
      }
    } else if (nextStock <= 0 && mainStaged) {
      await this.stagedRepo.update({ id: mainStaged.id }, { status: 'sold' as any });
    }
    // Registrar venta en tabla auxiliar (auto-creación si no existe)
    const soldAt = saleDateValue(body?.saleDate);
    if (!soldAt) throw new BadRequestException('invalid sale date');
    const sku = soldUnitSku;
    const explicitSalePrice = body?.salePrice;
    const parsedSalePrice =
      explicitSalePrice === undefined || explicitSalePrice === null || explicitSalePrice === ''
        ? Number.NaN
        : Number(explicitSalePrice);
    const fallbackPrice = Number(product?.price || 0);
    const price = Number.isFinite(parsedSalePrice)
      ? parsedSalePrice
      : (Number.isFinite(fallbackPrice) ? fallbackPrice : 0);
    const customerName = String(body?.name || body?.customerName || '').trim() || '-';
    const customerPhone = String(body?.phone || body?.customerPhone || '').replace(/\D+/g, '') || '-';
    const customerKindRaw = String(body?.customerKind || '').trim();
    const customerKind = ['tranquilo', 'regateador'].includes(customerKindRaw) ? customerKindRaw : 'tranquilo';
    const salePlaceTypeRaw = String(body?.salePlaceType || '').trim();
    const salePlaceType = ['almacen', 'otro'].includes(salePlaceTypeRaw) ? salePlaceTypeRaw : null;
    const saleLocation = salePlaceType === 'otro'
      ? (String(body?.saleLocation || '').trim() || null)
      : null;
    const mgr = this.productRepo.manager;
    await this.ensureSoldRecordsTable();
    await mgr.query(
      `INSERT INTO sold_records (product_id, sku, sale_price, sold_at, customer_name, customer_phone, customer_kind, sale_place_type, sale_location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [productId, sku, price, soldAt, customerName, customerPhone, customerKind, salePlaceType, saleLocation],
    );
    await this.ensurePossibleClientsTable();
    await mgr.query(
      `
      INSERT INTO possible_clients (
        source_request_id,
        cart_id,
        request_type,
        product_id,
        product_title,
        product_color,
        product_price,
        customer_name,
        customer_phone,
        location_scope,
        location_value,
        status,
        customer_kind,
        sale_place_type,
        sale_location,
        purchased_at
      )
      VALUES (NULL,$1,'manual-sale',$2,$3,$4,$5,$6,$7,'-','-','purchased',$8,$9,$10,$11)
      `,
      [
        `manual-${productId}-${Date.now()}`,
        productId,
        product.title || sku || 'Producto',
        product.color || null,
        price,
        customerName,
        customerPhone,
        customerKind,
        salePlaceType || null,
        saleLocation || null,
        soldAt,
      ],
    );
    return { ok: true };
  }

  @Post('public/:productId/unsell')
  async unmarkSold(
    @Headers('authorization') authHeader: string,
    @Param('productId') productId: string,
    @Body() body?: any,
  ) {
    this.requireAdmin(authHeader);
    // Restaurar estado del producto a 'listed' para volver a catálogo
    // Eliminar registros de venta asociados
    const mgr = this.productRepo.manager;
    await this.ensureSoldRecordsTable();
    const saleId = String(body?.saleId || '').trim();
    const records = saleId
      ? await mgr.query(`SELECT * FROM sold_records WHERE id = $1 AND product_id = $2 LIMIT 1`, [saleId, productId])
      : await mgr.query(`SELECT * FROM sold_records WHERE product_id = $1 ORDER BY sold_at DESC, created_at DESC LIMIT 1`, [productId]);
    const record = records?.[0];
    if (!record) throw new BadRequestException('sale record not found');

    const product = await this.productRepo.findOne({ where: { id: productId } });
    if (!product) throw new BadRequestException('product not found');

    const soldSku = String(record.sku || '').trim();
    const mainSku = String(product.sku || '').trim();
    const soldIsMain = soldSku.toLowerCase() === mainSku.toLowerCase();
    const nextStock = Math.max(1, Number(product.stock || 0) + 1);
    await this.productRepo.update({ id: productId }, { status: 'listed' as any, stock: nextStock });

    const mainStaged = mainSku ? await this.stagedRepo.findOne({ where: { sku: mainSku } }) : null;
    if (mainStaged) await this.stagedRepo.update({ id: mainStaged.id }, { status: 'published' as any });

    if (!soldIsMain && soldSku) {
      const linkedStaged = await this.stagedRepo
        .createQueryBuilder('staged')
        .where('LOWER(staged.sku) = :sku', { sku: soldSku.toLowerCase() })
        .getOne();
      if (linkedStaged) {
        const linkedNotes = parseNotes(linkedStaged.notes);
        await this.stagedRepo.update(
          { id: linkedStaged.id },
          {
            status: 'published' as any,
            notes: stringifyNotes({
              ...(linkedNotes || {}),
              linkedMainSku: mainSku,
              linkedMainTitle: product.title,
              linkedSkuGroup: {
                ...(linkedNotes?.linkedSkuGroup || {}),
                mainSku,
              },
            }),
          },
        );
      }
      await this.productRepo.update({ sku: soldSku }, { status: 'listed' as any, stock: 1 });
      if (mainStaged) {
        const mainNotes = parseNotes(mainStaged.notes);
        const currentSkus = Array.isArray(mainNotes?.linkedSkus)
          ? mainNotes.linkedSkus.map((value: unknown) => String(value || '').trim()).filter(Boolean)
          : [];
        const hasSku = currentSkus.some((sku: string) => sku.toLowerCase() === soldSku.toLowerCase());
        const linkedSkus = hasSku ? currentSkus : [...currentSkus, soldSku];
        await this.stagedRepo.update(
          { id: mainStaged.id },
          {
            notes: stringifyNotes({
              ...(mainNotes || {}),
              linkedSkus,
              linkedSkuGroup: {
                ...(mainNotes?.linkedSkuGroup || {}),
                mainSku,
                skus: linkedSkus,
              },
            }),
          },
        );
      }
    }

    await mgr.query(`DELETE FROM sold_records WHERE id = $1`, [record.id]);
    return { ok: true };
  }

  @Get('sales')
  async listSales(@Headers('authorization') authHeader: string) {
    this.requireAdmin(authHeader);
    const mgr = this.productRepo.manager;
    await this.ensureSoldRecordsTable();
    const rows = await mgr.query(`
      SELECT sr.*, p.title
      FROM sold_records sr
      LEFT JOIN products p ON p.id = sr.product_id
      ORDER BY sr.sold_at DESC, sr.created_at DESC
    `);
    return { items: rows };
  }

  @Put('sales/:saleId')
  async updateSale(
    @Headers('authorization') authHeader: string,
    @Param('saleId') saleId: string,
    @Body() body: any,
  ) {
    this.requireAdmin(authHeader);
    const mgr = this.productRepo.manager;
    await this.ensureSoldRecordsTable();

    const currentRows = await mgr.query(`SELECT * FROM sold_records WHERE id = $1 LIMIT 1`, [saleId]);
    const current = currentRows[0];
    if (!current) throw new BadRequestException('sale not found');

    const salePrice = Number(body?.salePrice);
    if (!Number.isFinite(salePrice) || salePrice < 0) throw new BadRequestException('invalid sale price');
    const soldAt = saleDateValue(body?.saleDate, new Date(current.sold_at));
    if (!soldAt) throw new BadRequestException('invalid sale date');
    const rows = await mgr.query(
      `UPDATE sold_records
       SET sale_price = $1,
           sold_at = $2
       WHERE id = $3
       RETURNING *`,
      [salePrice, soldAt, saleId],
    );
    const product = await this.productRepo.findOne({ where: { id: current.product_id } });
    return { ok: true, item: { ...rows[0], title: product?.title || null } };
  }

  @Get('contact-requests')
  async listContactRequests(@Headers('authorization') authHeader: string) {
    this.requireAdmin(authHeader);
    await this.ensureContactRequestsTable();
    const mgr = this.productRepo.manager;
    const rows = await mgr.query(`
      SELECT
        cr.id,
        cr.cart_id,
        cr.request_type,
        cr.product_id,
        cr.product_title,
        cr.product_color,
        cr.product_price,
        cr.customer_name,
        cr.customer_phone,
        cr.location_scope,
        cr.location_value,
        cr.metadata,
        cr.created_at
      FROM contact_requests cr
      ORDER BY cr.created_at DESC
      LIMIT 500
    `);
    return { items: rows };
  }

  @Post('contact-requests/:id/attended')
  async markContactRequestAttended(@Headers('authorization') authHeader: string, @Param('id') id: string) {
    this.requireAdmin(authHeader);
    await this.ensureContactRequestsTable();
    await this.ensurePossibleClientsTable();
    const mgr = this.productRepo.manager;
    const rows = await mgr.query(`SELECT * FROM contact_requests WHERE id = $1 LIMIT 1`, [id]);
    const request = rows?.[0];
    if (!request) throw new BadRequestException('contact request not found');

    const inserted = await mgr.query(
      `
      INSERT INTO possible_clients (
        source_request_id,
        cart_id,
        request_type,
        product_id,
        product_title,
        product_color,
        product_price,
        customer_name,
        customer_phone,
        location_scope,
        location_value,
        metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (source_request_id) DO UPDATE SET
        cart_id = EXCLUDED.cart_id,
        request_type = EXCLUDED.request_type,
        product_id = EXCLUDED.product_id,
        product_title = EXCLUDED.product_title,
        product_color = EXCLUDED.product_color,
        product_price = EXCLUDED.product_price,
        customer_name = EXCLUDED.customer_name,
        customer_phone = EXCLUDED.customer_phone,
        location_scope = EXCLUDED.location_scope,
        location_value = EXCLUDED.location_value,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING *
      `,
      [
        request.id,
        request.cart_id,
        request.request_type,
        request.product_id,
        request.product_title,
        request.product_color,
        request.product_price,
        request.customer_name,
        request.customer_phone,
        request.location_scope,
        request.location_value,
        request.metadata,
      ],
    );
    await mgr.query(`DELETE FROM contact_requests WHERE id = $1`, [id]);
    return { ok: true, item: inserted?.[0] || null };
  }

  @Get('possible-clients')
  async listPossibleClients(@Headers('authorization') authHeader: string) {
    this.requireAdmin(authHeader);
    await this.ensurePossibleClientsTable();
    const rows = await this.productRepo.manager.query(`
      SELECT *
      FROM possible_clients
      ORDER BY
        CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 500
    `);
    return { items: rows };
  }

  @Put('possible-clients/:id')
  async updatePossibleClient(@Headers('authorization') authHeader: string, @Param('id') id: string, @Body() body: any) {
    this.requireAdmin(authHeader);
    await this.ensurePossibleClientsTable();
    const mgr = this.productRepo.manager;
    const currentRows = await mgr.query(`SELECT * FROM possible_clients WHERE id = $1 LIMIT 1`, [id]);
    const current = currentRows?.[0];
    if (!current) throw new BadRequestException('possible client not found');

    const firstFilled = (...values: unknown[]) => {
      for (const value of values) {
        if (value !== undefined && value !== null) return value;
      }
      return null;
    };
    const customerName = String(firstFilled(body?.customerName, body?.customer_name, current.customer_name) || '').trim();
    const customerPhone = String(firstFilled(body?.customerPhone, body?.customer_phone, current.customer_phone) || '').replace(/\D+/g, '');
    if (!customerName) throw new BadRequestException('customer name required');
    if (!customerPhone) throw new BadRequestException('customer phone required');

    const productPriceRaw = firstFilled(body?.productPrice, body?.product_price, current.product_price, 0);
    const productPrice = Number(productPriceRaw || 0);
    const customerKind = String(firstFilled(body?.customerKind, body?.customer_kind, current.customer_kind, '') || '').trim();
    const salePlaceType = String(firstFilled(body?.salePlaceType, body?.sale_place_type, current.sale_place_type, '') || '').trim();
    const saleLocationRaw = String(firstFilled(body?.saleLocation, body?.sale_location, current.sale_location, '') || '').trim();
    const saleLocation = salePlaceType === 'otro' ? saleLocationRaw : '';

    if (customerKind && !['tranquilo', 'regateador'].includes(customerKind)) throw new BadRequestException('invalid customer kind');
    if (salePlaceType && !['almacen', 'otro'].includes(salePlaceType)) throw new BadRequestException('invalid sale place');
    if (salePlaceType === 'otro' && !saleLocation) throw new BadRequestException('sale location required');

    const rows = await mgr.query(
      `
      UPDATE possible_clients
      SET request_type = $2,
          product_title = $3,
          product_color = $4,
          product_price = $5,
          customer_name = $6,
          customer_phone = $7,
          location_scope = $8,
          location_value = $9,
          customer_kind = $10,
          sale_place_type = $11,
          sale_location = $12,
          updated_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [
        id,
        String(firstFilled(body?.requestType, body?.request_type, current.request_type, '') || '').trim() || null,
        String(firstFilled(body?.productTitle, body?.product_title, current.product_title, '') || '').trim() || null,
        String(firstFilled(body?.productColor, body?.product_color, current.product_color, '') || '').trim() || null,
        Number.isFinite(productPrice) ? productPrice : 0,
        customerName,
        customerPhone,
        String(firstFilled(body?.locationScope, body?.location_scope, current.location_scope, '') || '').trim() || null,
        String(firstFilled(body?.locationValue, body?.location_value, current.location_value, '') || '').trim() || null,
        customerKind || null,
        salePlaceType || null,
        saleLocation || null,
      ],
    );
    return { ok: true, item: rows[0] };
  }

  @Post('possible-clients/:id/discard')
  async discardPossibleClient(@Headers('authorization') authHeader: string, @Param('id') id: string) {
    this.requireAdmin(authHeader);
    await this.ensurePossibleClientsTable();
    await this.productRepo.manager.query(`DELETE FROM possible_clients WHERE id = $1`, [id]);
    return { ok: true };
  }

  @Post('possible-clients/:id/purchase')
  async markPossibleClientPurchased(@Headers('authorization') authHeader: string, @Param('id') id: string, @Body() body: any) {
    this.requireAdmin(authHeader);
    await this.ensurePossibleClientsTable();
    const customerKind = String(body?.customerKind || '').trim();
    const salePlaceTypeRaw = String(body?.salePlaceType || '').trim();
    const salePlaceType = ['almacen', 'otro'].includes(salePlaceTypeRaw) ? salePlaceTypeRaw : null;
    const saleLocation = String(body?.saleLocation || '').trim();
    if (!['tranquilo', 'regateador'].includes(customerKind)) throw new BadRequestException('invalid customer kind');
    if (salePlaceType === 'otro' && !saleLocation) throw new BadRequestException('sale location required');

    const rows = await this.productRepo.manager.query(
      `
      UPDATE possible_clients
      SET status = 'purchased',
          customer_kind = $2,
          sale_place_type = $3,
          sale_location = $4,
          purchased_at = now(),
          updated_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [id, customerKind, salePlaceType, salePlaceType === 'otro' ? saleLocation : null],
    );
    if (!rows?.[0]) throw new BadRequestException('possible client not found');
    return { ok: true, item: rows[0] };
  }

  @Get('analytics/views')
  async listViewAnalytics(@Headers('authorization') authHeader: string, @Query('days') days = '30') {
    this.requireAdmin(authHeader);
    await this.ensureCatalogViewsTable();

    const safeDays = Math.min(365, Math.max(1, Number(days) || 30));
    const rows = await this.viewRepo.manager.query(
      `
        SELECT
          product_id,
          product_slug,
          product_title,
          category,
          session_id,
          created_at
        FROM catalog_views
        WHERE created_at >= now() - ($1::int * interval '1 day')
        ORDER BY created_at DESC
      `,
      [safeDays],
    );

    const totalViews = rows.length;
    const uniqueVisitors = new Set(rows.map((row: any) => String(row.session_id || ''))).size;
    const byCategory = new Map<string, {
      category: string;
      totalViews: number;
      uniqueVisitors: Set<string>;
      lastViewedAt: string;
      products: Map<string, {
        productId: string;
        slug: string;
        title: string;
        totalViews: number;
        uniqueVisitors: Set<string>;
        lastViewedAt: string;
      }>;
    }>();

    for (const row of rows) {
      const category = String(row.category || 'sin categoria');
      const sessionId = String(row.session_id || '');
      const productId = String(row.product_id || '');
      const slug = String(row.product_slug || '');
      const title = String(row.product_title || slug || 'Producto');
      const createdAt = analyticsDateIso(row.created_at);

      if (!byCategory.has(category)) {
        byCategory.set(category, {
          category,
          totalViews: 0,
          uniqueVisitors: new Set<string>(),
          lastViewedAt: createdAt,
          products: new Map(),
        });
      }

      const categoryRow = byCategory.get(category)!;
      categoryRow.totalViews += 1;
      if (sessionId) categoryRow.uniqueVisitors.add(sessionId);
      if (createdAt && (!categoryRow.lastViewedAt || createdAt > categoryRow.lastViewedAt)) {
        categoryRow.lastViewedAt = createdAt;
      }

      if (!categoryRow.products.has(productId)) {
        categoryRow.products.set(productId, {
          productId,
          slug,
          title,
          totalViews: 0,
          uniqueVisitors: new Set<string>(),
          lastViewedAt: createdAt,
        });
      }

      const productRow = categoryRow.products.get(productId)!;
      productRow.totalViews += 1;
      if (sessionId) productRow.uniqueVisitors.add(sessionId);
      if (createdAt && (!productRow.lastViewedAt || createdAt > productRow.lastViewedAt)) {
        productRow.lastViewedAt = createdAt;
      }
    }

    const categories = Array.from(byCategory.values())
      .map((categoryRow) => ({
        category: categoryRow.category,
        totalViews: categoryRow.totalViews,
        uniqueVisitors: categoryRow.uniqueVisitors.size,
        productsCount: categoryRow.products.size,
        lastViewedAt: categoryRow.lastViewedAt,
        products: Array.from(categoryRow.products.values())
          .map((productRow) => ({
            productId: productRow.productId,
            slug: productRow.slug,
            title: productRow.title,
            totalViews: productRow.totalViews,
            uniqueVisitors: productRow.uniqueVisitors.size,
            lastViewedAt: productRow.lastViewedAt,
          }))
          .sort((a, b) => analyticsLastViewedDesc(a, b) || b.totalViews - a.totalViews || a.title.localeCompare(b.title)),
      }))
      .sort((a, b) => analyticsLastViewedDesc(a, b) || analyticsCategoryRank(a.category) - analyticsCategoryRank(b.category) || a.category.localeCompare(b.category));

    return {
      days: safeDays,
      summary: {
        totalViews,
        uniqueVisitors,
        categoriesCount: categories.length,
        productsCount: categories.reduce((sum, category) => sum + category.productsCount, 0),
      },
      categories,
    };
  }
}
