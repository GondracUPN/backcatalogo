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

function promotionDiscountMode(notes: any, fallback?: unknown) {
  const raw = String(fallback ?? notes?.discountMode ?? notes?.discountType ?? 'percent').toLowerCase();
  return raw === 'amount' || raw === 'flat' || raw === 'soles' ? 'amount' : 'percent';
}

function promotionFinalPrice(price: number, discount: number, mode: string) {
  const computed = mode === 'amount' ? price - discount : price * (1 - discount / 100);
  return +Math.max(0, computed).toFixed(2);
}

@Controller('admin')
export class AdminController {
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
        items = items.filter((item: any) => String(item?.status || '').toLowerCase() !== 'published');
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
    if (q) where.title = ILike(`%${q}%`);
    if (status) where.status = status;
    else where.status = Not('published' as any);
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

    let skuBase = String(body?.sku || '').trim().toUpperCase();
    if (!skuBase) skuBase = 'PREV';
    let sku = `${skuBase}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    for (let tries = 0; tries < 10; tries += 1) {
      const existingProduct = await this.productRepo.findOne({ where: { sku } });
      const existingStaged = await this.stagedRepo.findOne({ where: { sku } });
      if (!existingProduct && !existingStaged) break;
      sku = `${skuBase}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
      if (tries === 9) throw new BadRequestException('sku unavailable');
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
      if (!includes) throw new BadRequestException('includes required');
      if (!IPHONE_INCLUDES_VALUES.has(String(includes))) {
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
    if (productCondition !== 'Nuevo' && includes === 'Otros' && !includesExtra) {
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
    const variantGroup = String(staged.variant_group || '').trim();
    const requestedSlug = String(body?.slug || '').trim();
    const baseSlug = variantGroup
      ? slugify(`${requestedSlug || variantGroup}-${staged.sku}`)
      : slugify(requestedSlug || publishTitle);
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
        variant_group: staged.variant_group || null,
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
    await this.stagedRepo.update({ id }, { status: 'published' as any, title: publishTitle });
    return { ok: true, result: pub.identifiers?.[0], warnings: validation.warnings };
  }

  @Get('catalog')
  async listAdminCatalog(@Headers('authorization') authHeader: string) {
    this.requireAdmin(authHeader);
    const products = await this.productRepo.find({
      order: { updated_at: 'DESC' as any },
      take: 500,
    });
    const productIds = products.map((p) => p.id);
    const skus = products.map((p) => p.sku).filter(Boolean);
    const pubs = productIds.length ? await this.publicRepo.findBy({ product_id: In(productIds) }) : [];
    const stagedRows = skus.length ? await this.stagedRepo.findBy({ sku: In(skus) }) : [];
    const pubByProduct = new Map(pubs.map((p) => [p.product_id, p] as const));
    const stagedBySku = new Map(stagedRows.map((s) => [s.sku, s] as const));

    const items = products
      .filter((product) => product.status !== 'sold')
      .filter((product) => {
        const pub = pubByProduct.get(product.id);
        const staged = stagedBySku.get(product.sku);
        return Boolean(pub?.is_published) || (!pub && String(staged?.status || '').toLowerCase() === 'published');
      })
      .map((product) => {
        const pub = pubByProduct.get(product.id);
        const staged = stagedBySku.get(product.sku) || null;
        return {
          id: pub?.id || product.id,
          product_id: product.id,
          slug: pub?.slug || null,
          is_published: Boolean(pub?.is_published),
          category: pub?.category || staged?.category || null,
          images: pub?.images || staged?.images || [],
          product,
          staged,
        };
      });

    return { items };
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
        const variantGroup = String(s.variant_group || '').trim();
        const baseSlug = variantGroup ? slugify(`${variantGroup}-${s.sku}`) : slugify(publishTitle);
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
    await this.productRepo.update({ id: productId }, { status: 'sold' as any });
    // Registrar venta en tabla auxiliar (auto-creación si no existe)
    const soldAt = body?.saleDate ? new Date(body.saleDate) : new Date();
    const sku = product?.sku || '';
    const explicitSalePrice = body?.salePrice;
    const parsedSalePrice =
      explicitSalePrice === undefined || explicitSalePrice === null || explicitSalePrice === ''
        ? Number.NaN
        : Number(explicitSalePrice);
    const fallbackPrice = Number(product?.price || 0);
    const price = Number.isFinite(parsedSalePrice)
      ? parsedSalePrice
      : (Number.isFinite(fallbackPrice) ? fallbackPrice : 0);
    const mgr = this.productRepo.manager;
    await mgr.query(`CREATE TABLE IF NOT EXISTS sold_records (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      product_id uuid NOT NULL,
      sku text,
      sale_price numeric(12,2) NOT NULL DEFAULT 0,
      sold_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await mgr.query(`INSERT INTO sold_records (product_id, sku, sale_price, sold_at) VALUES ($1,$2,$3,$4)`, [productId, sku, price, soldAt]);
    return { ok: true };
  }

  @Post('public/:productId/unsell')
  async unmarkSold(
    @Headers('authorization') authHeader: string,
    @Param('productId') productId: string,
  ) {
    this.requireAdmin(authHeader);
    // Restaurar estado del producto a 'listed' para volver a catálogo
    await this.productRepo.update({ id: productId }, { status: 'listed' as any });
    // Eliminar registros de venta asociados
    const mgr = this.productRepo.manager;
    await mgr.query(`CREATE TABLE IF NOT EXISTS sold_records (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      product_id uuid NOT NULL,
      sku text,
      sale_price numeric(12,2) NOT NULL DEFAULT 0,
      sold_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await mgr.query(`DELETE FROM sold_records WHERE product_id = $1`, [productId]);
    return { ok: true };
  }

  @Get('sales')
  async listSales(@Headers('authorization') authHeader: string) {
    this.requireAdmin(authHeader);
    const mgr = this.productRepo.manager;
    await mgr.query(`CREATE TABLE IF NOT EXISTS sold_records (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      product_id uuid NOT NULL,
      sku text,
      sale_price numeric(12,2) NOT NULL DEFAULT 0,
      sold_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    const rows = await mgr.query(`
      SELECT sr.*, p.title
      FROM sold_records sr
      LEFT JOIN products p ON p.id = sr.product_id
      ORDER BY sr.sold_at DESC, sr.created_at DESC
      LIMIT 500
    `);
    return { items: rows };
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
      const createdAt = String(row.created_at || '');

      if (!byCategory.has(category)) {
        byCategory.set(category, {
          category,
          totalViews: 0,
          uniqueVisitors: new Set<string>(),
          products: new Map(),
        });
      }

      const categoryRow = byCategory.get(category)!;
      categoryRow.totalViews += 1;
      if (sessionId) categoryRow.uniqueVisitors.add(sessionId);

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
        products: Array.from(categoryRow.products.values())
          .map((productRow) => ({
            productId: productRow.productId,
            slug: productRow.slug,
            title: productRow.title,
            totalViews: productRow.totalViews,
            uniqueVisitors: productRow.uniqueVisitors.size,
            lastViewedAt: productRow.lastViewedAt,
          }))
          .sort((a, b) => b.totalViews - a.totalViews || b.uniqueVisitors - a.uniqueVisitors || a.title.localeCompare(b.title)),
      }))
      .sort((a, b) => b.totalViews - a.totalViews || b.uniqueVisitors - a.uniqueVisitors || a.category.localeCompare(b.category));

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
