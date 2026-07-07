import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { CatalogPublic } from '../../entities/catalog-public.entity';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { StagedProduct } from '../../entities/staged-product.entity';
import { CatalogView } from '../../entities/catalog-view.entity';

function normalizeVariantKey(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .replace(/\s+/g, ' ');
}

@Controller('catalog')
export class CatalogController {
  constructor(
    @InjectRepository(CatalogPublic) private publicRepo: Repository<CatalogPublic>,
    @InjectRepository(CatalogProduct) private productRepo: Repository<CatalogProduct>,
    @InjectRepository(StagedProduct) private stagedRepo: Repository<StagedProduct>,
    @InjectRepository(CatalogView) private viewRepo: Repository<CatalogView>,
  ) {}

  private parseNotes(row: any) {
    try {
      return row?.notes && typeof row.notes === 'string' ? JSON.parse(row.notes) : row?.notes || {};
    } catch {
      return {};
    }
  }

  private publicNotes(staged: StagedProduct | null) {
    const notes = this.parseNotes(staged);
    const specs = notes?.specs || {};
    const sourceDetail = specs?.detalle || notes?.detalle || {};
    const detailKeys = [
      'gama', 'procesador', 'generacion', 'numero', 'modelo',
      'tamaño', 'tamanio', 'tamano', 'almacenamiento', 'ram',
      'conexion', 'conectividad', 'esim', 'sim', 'descripcionOtro',
      'detalles', 'productDetails', 'detailImages',
    ];
    const detail = Object.fromEntries(
      detailKeys
        .filter((key) => sourceDetail?.[key] !== undefined)
        .map((key) => [key, sourceDetail[key]]),
    );
    const publicKeys = [
      'saleType', 'discount', 'discountMode', 'discountType', 'finalPrice',
      'precioLista', 'descuentoPorc', 'color', 'batteryHealth', 'batteryCycles',
      'bateria', 'iphoneModel', 'iphoneNumber', 'storageGb', 'storage',
      'iphoneSimType', 'simType', 'chipType', 'preventaDateFrom', 'preventaDateTo',
      'preventa', 'warrantyDate', 'warrantyEnabled', 'garantiaFecha', 'garantia',
      'garantiaActiva', 'conectividad', 'watchType', 'watchSeries', 'watchVersion',
      'watchConnection', 'watchAccessories', 'watchIncludes', 'productCondition',
      'estado', 'includes', 'includesExtra', 'incluye', 'descripcionOtro',
      'cuboFake', 'cableFake',
      'productDetails', 'detalles', 'detailImages', 'detailPhotos',
    ];
    const result = Object.fromEntries(
      publicKeys
        .filter((key) => notes?.[key] !== undefined)
        .map((key) => [key, notes[key]]),
    ) as any;
    result.detalle = detail;
    result.specs = {
      tipo: specs?.tipo ?? null,
      estado: specs?.estado ?? notes?.estado ?? null,
      sim: specs?.sim ?? detail?.sim ?? detail?.esim ?? null,
      conCaja: specs?.conCaja ?? null,
      detalle: detail,
    };
    return result;
  }

  private publicProduct(product: CatalogProduct | null) {
    if (!product) return null;
    return {
      id: product.id,
      title: product.title,
      price: product.price,
      iphone_model: product.iphone_model,
      iphone_number: product.iphone_number,
      storage_gb: product.storage_gb,
      battery_cycles: product.battery_cycles,
      battery_health: product.battery_health,
      color: product.color,
      includes: product.includes,
      includes_extra: product.includes_extra,
      keyboard_layout: product.keyboard_layout,
      sale_type: product.sale_type,
      discount: product.discount,
      final_price: product.final_price,
      min_offer_price: product.min_offer_price,
      status: product.status,
      product_condition: product.product_condition,
      stock: product.stock,
    };
  }

  private publicStaged(staged: StagedProduct | null) {
    if (!staged) return null;
    return {
      title: staged.title,
      price: staged.price,
      iphone_model: staged.iphone_model,
      iphone_number: staged.iphone_number,
      storage_gb: staged.storage_gb,
      battery_cycles: staged.battery_cycles,
      battery_health: staged.battery_health,
      color: staged.color,
      includes: staged.includes,
      includes_extra: staged.includes_extra,
      keyboard_layout: staged.keyboard_layout,
      sale_type: staged.sale_type,
      discount: staged.discount,
      final_price: staged.final_price,
      min_offer_price: staged.min_offer_price,
      stock: staged.stock,
      status: staged.status,
      product_condition: staged.product_condition,
      category: staged.category,
      images: staged.images,
      notes: this.publicNotes(staged),
    };
  }

  private priceMeta(product: CatalogProduct | undefined, staged: StagedProduct | undefined) {
    const notes = this.parseNotes(staged);
    const saleType = String(product?.sale_type || staged?.sale_type || notes?.saleType || '').toUpperCase();
    const salePrice = Number(product?.price ?? staged?.price ?? 0);
    const discount = Number(product?.discount ?? staged?.discount ?? notes?.discount ?? notes?.descuentoPorc ?? 0);
    const discountMode = String(notes?.discountMode || notes?.discountType || 'percent').toLowerCase();
    const finalPrice = product?.final_price ?? staged?.final_price ?? notes?.finalPrice ?? null;
    let price = salePrice;
    let compareAt: number | null = null;
    let promoLabel = '';

    if (saleType === 'PROMOCION') {
      const computed = finalPrice !== null
        ? Number(finalPrice)
        : +(discountMode === 'amount' ? Math.max(0, salePrice - discount) : salePrice * (1 - discount / 100)).toFixed(2);
      if (isFinite(computed) && computed > 0) price = computed;
      compareAt = salePrice || null;
      const savings = compareAt && compareAt > price ? compareAt - price : 0;
      promoLabel = discountMode === 'amount' && discount > 0
        ? `Ahorra S/ ${discount.toFixed(2)}`
        : discount > 0
          ? `${discount}% OFF`
          : savings > 0
            ? `Ahorra S/ ${savings.toFixed(2)}`
            : '';
    } else if (!saleType && typeof notes?.precioLista !== 'undefined') {
      compareAt = notes?.precioLista ? Number(notes.precioLista) : null;
      if ((!price || price <= 0) && typeof notes?.precioLista !== 'undefined') {
        const p = Number(notes?.precioLista || 0);
        const d = Number(notes?.descuentoPorc || 0);
        const f = +(p * (1 - d / 100)).toFixed(2);
        if (isFinite(f) && f > 0) price = f;
      }
    }

    const condition = String(
      product?.product_condition ||
        staged?.product_condition ||
        notes?.productCondition ||
        notes?.estado ||
        ''
    );

    return { condition, saleType, price: isFinite(price) ? price : 0, compareAt, discount, discountMode, promoLabel };
  }

  private compactRow(pub: CatalogPublic, product: CatalogProduct | undefined, staged: StagedProduct | undefined) {
    const img = (Array.isArray(pub.images) && pub.images[0]) || (Array.isArray(staged?.images) && staged?.images[0]) || '/placeholder.svg';
    const { condition, saleType, price, compareAt, discount, discountMode, promoLabel } = this.priceMeta(product, staged);
    const notes = this.parseNotes(staged);
    const stock = Number(product?.stock ?? staged?.stock ?? 1);
    const sold = product?.status === 'sold';
    const outOfStock = !sold && Number.isFinite(stock) && stock <= 0;
    const available = Boolean(pub.is_published) && !sold && !outOfStock;
    const batteryHealth = product?.battery_health ?? staged?.battery_health ?? notes?.batteryHealth ?? notes?.bateria?.salud ?? null;
    const includesValue = product?.includes || staged?.includes || notes?.includes || '';
    const includesExtra = product?.includes_extra || staged?.includes_extra || notes?.includesExtra || '';
    const includesDisplay = includesValue && includesValue !== 'Ninguno'
      ? (includesValue === 'Otros' ? includesExtra : includesValue)
      : '';
    const variantLabel = [
      product?.color || staged?.color || notes?.color || '',
      batteryHealth ? `${batteryHealth}% bateria` : '',
      includesDisplay,
    ].filter(Boolean).join(' · ');
    return {
      id: pub.id,
      product_id: pub.product_id,
      slug: pub.slug,
      category: pub.category,
      image: img,
      images: Array.isArray(pub.images) ? pub.images : [],
      title: product?.title || staged?.title || pub.slug,
      condition,
      saleType,
      discount,
      discountMode,
      promoLabel,
      price,
      compareAt,
      status: product?.status || null,
      stock: Number.isFinite(stock) ? stock : 1,
      available,
      availabilityLabel: sold ? 'Vendido' : outOfStock ? 'Agotado' : 'Disponible',
      variantGroup: product?.variant_group || staged?.variant_group || notes?.variantGroup || notes?.variant_group || null,
      variantLabel,
      color: product?.color || staged?.color || notes?.color || null,
      batteryHealth,
      includes: includesDisplay || null,
    };
  }

  private async publicRowsForProductIds(productIds: string[]) {
    const ids = Array.from(new Set(productIds.map((id) => String(id || '').trim()).filter(Boolean)));
    if (!ids.length) return [] as CatalogPublic[];
    return this.publicRepo.find({
      where: { product_id: In(ids), is_published: true as any },
      order: { sort_order: 'ASC' as any, created_at: 'DESC' as any },
      take: 40,
    });
  }

  private async productIdsFromStaged(stagedRows: StagedProduct[]) {
    const ids = new Set<string>();
    for (const row of stagedRows) {
      if (row.source_id) ids.add(row.source_id);
    }

    const skus = Array.from(new Set(stagedRows.map((row) => String(row.sku || '').trim()).filter(Boolean)));
    if (skus.length) {
      const products = await this.productRepo.find({
        where: { sku: In(skus) },
        take: skus.length,
      });
      for (const product of products) ids.add(product.id);
    }

    return ids;
  }

  private async findVariantPubs(params: { variantGroup?: string; title?: string }) {
    const byId = new Map<string, CatalogPublic>();
    const addPubs = (pubs: CatalogPublic[]) => {
      for (const row of pubs) byId.set(row.id, row);
    };

    const variantGroup = String(params.variantGroup || '').trim();
    if (variantGroup) {
      const [groupProducts, groupStaged] = await Promise.all([
        this.productRepo.find({ where: { variant_group: variantGroup as any }, take: 40 }),
        this.stagedRepo.find({ where: { variant_group: variantGroup as any }, take: 40 }),
      ]);
      const ids = new Set(groupProducts.map((product) => product.id));
      for (const id of await this.productIdsFromStaged(groupStaged)) ids.add(id);
      addPubs(await this.publicRowsForProductIds(Array.from(ids)));
    }

    const title = String(params.title || '').trim();
    if (title) {
      const [titleProducts, titleStaged] = await Promise.all([
        this.productRepo.find({ where: { title }, take: 40 }),
        this.stagedRepo.find({ where: { title }, take: 40 }),
      ]);
      const ids = new Set(titleProducts.map((product) => product.id));
      for (const id of await this.productIdsFromStaged(titleStaged)) ids.add(id);
      addPubs(await this.publicRowsForProductIds(Array.from(ids)));
    }

    return Array.from(byId.values());
  }

  private async hydratePublicRows(pubs: CatalogPublic[]) {
    const productIds = pubs.map((pub) => pub.product_id);
    const products = productIds.length ? await this.productRepo.findBy({ id: In(productIds) }) : [];
    const productById = new Map(products.map((product) => [product.id, product] as const));

    const skus = Array.from(new Set(products.map((product) => String(product.sku || '').trim()).filter(Boolean)));
    const [stagedBySku, stagedByPid] = await Promise.all([
      skus.length ? this.stagedRepo.findBy({ sku: In(skus) }) : Promise.resolve([] as StagedProduct[]),
      productIds.length ? this.stagedRepo.findBy({ source_id: In(productIds) }) : Promise.resolve([] as StagedProduct[]),
    ]);
    const stagedBySkuMap = new Map(stagedBySku.map((row) => [row.sku, row] as const));
    const stagedByPidMap = new Map(stagedByPid.map((row) => [row.source_id, row] as const));

    return pubs.map((pub) => {
      const product = productById.get(pub.product_id);
      const staged = product?.sku ? (stagedBySkuMap.get(product.sku) || stagedByPidMap.get(pub.product_id)) : stagedByPidMap.get(pub.product_id);
      return { pub, product, staged };
    });
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

  @Get()
  async list(@Query('q') q?: string, @Query('category') category?: string) {
    const where: any = { is_published: true };
    if (category) where.category = category;
    const order = { sort_order: 'ASC' as any, created_at: 'DESC' as any };
    const pubs = await this.publicRepo.find({ where, order });
    const productIds = pubs.map((p) => p.product_id);
    const products = productIds.length ? await this.productRepo.findBy({ id: In(productIds) }) : [];
    const pMap = new Map(products.map((p) => [p.id, p] as const));
    // Preferir vincular staged por SKU del producto.
    const skus = products.map((p) => p.sku).filter(Boolean);
    const stagedBySku = skus.length ? await this.stagedRepo.findBy({ sku: In(skus) }) : [];
    const sBySku = new Map(stagedBySku.map((s) => [s.sku, s] as const));
    // Fallback: referencias antiguas por source_id.
    const stagedByPid = productIds.length ? await this.stagedRepo.findBy({ source_id: In(productIds) }) : [];
    const sByPid = new Map(stagedByPid.map((s) => [s.source_id, s] as const));

    const items = pubs
      .map((p) => {
        const product = pMap.get(p.product_id);
        const staged = product ? (sBySku.get(product.sku) || sByPid.get(p.product_id)) : sByPid.get(p.product_id);
        return {
          id: p.id,
          product_id: p.product_id,
          slug: p.slug,
          category: p.category,
          images: Array.isArray(p.images) ? p.images : [],
          product: this.publicProduct(product || null),
          staged: this.publicStaged(staged || null),
        };
      })
      // Ocultar productos vendidos del catálogo público.
      .filter((row) => row.product?.status !== 'sold')
      .filter((row) => (q ? String(row.product?.title || '').toLowerCase().includes(String(q).toLowerCase()) : true));
    return { items };
  }

  @Get('home')
  async home() {
    const pubs = await this.publicRepo.find({
      where: { is_published: true },
      order: { sort_order: 'ASC' as any, created_at: 'DESC' as any },
    });
    const productIds = pubs.map((p) => p.product_id);
    const products = productIds.length ? await this.productRepo.findBy({ id: In(productIds) }) : [];
    const pMap = new Map(products.map((p) => [p.id, p] as const));
    const skus = products.map((p) => p.sku).filter(Boolean);
    const stagedBySku = skus.length ? await this.stagedRepo.findBy({ sku: In(skus) }) : [];
    const sBySku = new Map(stagedBySku.map((s) => [s.sku, s] as const));
    const stagedByPid = productIds.length ? await this.stagedRepo.findBy({ source_id: In(productIds) }) : [];
    const sByPid = new Map(stagedByPid.map((s) => [s.source_id, s] as const));

    const rows = pubs
      .map((pub) => {
        const product = pMap.get(pub.product_id);
        const staged = product ? (sBySku.get(product.sku) || sByPid.get(pub.product_id)) : sByPid.get(pub.product_id);
        return { pub, product, staged };
      })
      .filter((row) => row.product?.status !== 'sold');

    const categories = new Map<string, { key: string; total: number; minPrice: number | null }>();
    for (const row of rows) {
      const key = String(row.pub.category || '').toLowerCase();
      if (!key) continue;
      const current = categories.get(key) || { key, total: 0, minPrice: null };
      const price = this.priceMeta(row.product, row.staged).price;
      current.total += 1;
      if (price > 0 && (current.minPrice === null || price < current.minPrice)) current.minPrice = price;
      categories.set(key, current);
    }

    const bestRows = [...rows].sort((a, b) => {
      const aTime = new Date(a.pub.created_at || 0).getTime() || 0;
      const bTime = new Date(b.pub.created_at || 0).getTime() || 0;
      return bTime - aTime;
    });

    const items = bestRows.slice(0, 8).map((row) => this.compactRow(row.pub, row.product, row.staged));

    return { items, categories: Array.from(categories.values()) };
  }

  @Get(':slug')
  async getOne(@Param('slug') slug: string) {
    let pub = await this.publicRepo.findOne({ where: { slug, is_published: true as any } });
    if (!pub) {
      const legacySku = slug.match(/-(svc-\d+)$/i)?.[1];
      if (legacySku) {
        const legacyProduct = await this.productRepo
          .createQueryBuilder('product')
          .where('LOWER(product.sku) = LOWER(:sku)', { sku: legacySku })
          .getOne();
        if (legacyProduct) {
          pub = await this.publicRepo.findOne({
            where: { product_id: legacyProduct.id, is_published: true as any },
          });
        }
      }
    }
    if (!pub) throw new NotFoundException('not found');
    const [product, stagedBySource] = await Promise.all([
      this.productRepo.findOne({ where: { id: pub.product_id } }),
      this.stagedRepo.findOne({ where: { source_id: pub.product_id } }),
    ]);
    let staged: StagedProduct | null = stagedBySource;
    if (!staged && product?.sku) staged = await this.stagedRepo.findOne({ where: { sku: product.sku } });
    const notes = this.parseNotes(staged);
    const variantGroup = String(product?.variant_group || staged?.variant_group || notes?.variantGroup || notes?.variant_group || '').trim();
    let variants: any[] = [];
    const activeTitleKey = normalizeVariantKey(product?.title || staged?.title || '');
    const activeCategoryKey = normalizeVariantKey(pub.category || staged?.category || '');
    const activeGroupKey = normalizeVariantKey(variantGroup);

    const variantPubs = await this.findVariantPubs({
      variantGroup,
      title: product?.title || staged?.title || '',
    });
    const variantRows = await this.hydratePublicRows(variantPubs);

    variants = variantRows
      .map(({ pub: variantPub, product: variantProduct, staged: variantStaged }) => {
        const variantNotes = this.parseNotes(variantStaged);
        const rowGroup = String(
          variantProduct?.variant_group ||
            variantStaged?.variant_group ||
            variantNotes?.variantGroup ||
            variantNotes?.variant_group ||
            ''
        ).trim();
        const sameExplicitGroup = activeGroupKey && normalizeVariantKey(rowGroup) === activeGroupKey;
        const sameTitle =
          !activeGroupKey &&
          activeTitleKey &&
          normalizeVariantKey(variantProduct?.title || variantStaged?.title || '') === activeTitleKey &&
          normalizeVariantKey(variantPub.category || variantStaged?.category || '') === activeCategoryKey;
        if (!sameExplicitGroup && !sameTitle) return null;
        return this.compactRow(variantPub, variantProduct, variantStaged);
      })
      .filter(Boolean)
      .sort((a: any, b: any) => String(a.variantLabel || a.title).localeCompare(String(b.variantLabel || b.title)));

    return {
      item: {
        id: pub.id,
        product_id: pub.product_id,
        slug: pub.slug,
        category: pub.category,
        images: pub.images,
        product: this.publicProduct(product),
        staged: this.publicStaged(staged),
        variants,
      },
    };
  }

  @Post('views')
  @HttpCode(200)
  async trackView(@Body() body: any) {
    const productId = String(body?.productId || '').trim();
    const productSlug = String(body?.productSlug || '').trim();
    const sessionId = String(body?.sessionId || '').trim();
    const path = String(body?.path || '').trim();

    if (!productId || !productSlug || !sessionId) {
      return { ok: false };
    }

    const published = await this.publicRepo.findOne({
      where: { product_id: productId, slug: productSlug, is_published: true as any },
    });
    if (!published) {
      return { ok: false };
    }

    const product = await this.productRepo.findOne({ where: { id: productId } });
    if (!product || product.status === 'sold') {
      return { ok: false };
    }

    await this.ensureCatalogViewsTable();
    await this.viewRepo.insert({
      product_id: published.product_id,
      product_slug: published.slug,
      product_title: product.title || null,
      category: published.category || null,
      session_id: sessionId,
      path: path || null,
    });
    return { ok: true };
  }
}
