import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
import { CatalogPublic } from '../../entities/catalog-public.entity';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { StagedProduct } from '../../entities/staged-product.entity';
import { CatalogView } from '../../entities/catalog-view.entity';
import { runOnce } from '../../utils/run-once';
import { parseRowNotes, publicNotes, publicProduct, publicStaged } from '../../utils/public-catalog';
import { applyReservedQty, reservedQtyByProduct } from '../../utils/stock-reservations';
import { normalizeAppleTitle, normalizeColorName } from '../../utils/display-names';
import { AVAILABILITY_LABEL, PublicAvailability, familyKey, isSellable, publicAvailability } from '../../utils/catalog-family';

type HydratedRow = { pub: CatalogPublic; product?: CatalogProduct; staged?: StagedProduct; availability: PublicAvailability };

function publicCategoryGroup(value: unknown) {
  const category = String(value || '').trim().toLowerCase();
  return ['macbook', 'ipad', 'iphone', 'watch'].includes(category) ? category : 'otros';
}

@Controller('catalog')
export class CatalogController {
  constructor(
    @InjectRepository(CatalogPublic) private publicRepo: Repository<CatalogPublic>,
    @InjectRepository(CatalogProduct) private productRepo: Repository<CatalogProduct>,
    @InjectRepository(StagedProduct) private stagedRepo: Repository<StagedProduct>,
    @InjectRepository(CatalogView) private viewRepo: Repository<CatalogView>,
  ) {}

  @Get('client-purchases')
  async clientPurchases() {
    // Only publish the photo and the purchased product; customer details stay private.
    const sales = await this.productRepo.manager.query(`
      SELECT sr.id::text, sr.client_photo_url AS "photoUrl",
        COALESCE(NULLIF(BTRIM(sr.product_title), ''), p.title) AS "productTitle",
        COALESCE(NULLIF(BTRIM(to_jsonb(sr)->>'product_image_url'), ''), cp.images->>0) AS "productImageUrl",
        cp.category AS "category",
        sr.sold_at AS "purchasedAt"
      FROM sold_records sr
      LEFT JOIN products p ON p.id = sr.product_id
      -- La categoría y la foto del equipo viven en la ficha pública (products no tiene category).
      LEFT JOIN catalog_public cp ON cp.product_id = sr.product_id
      WHERE NULLIF(BTRIM(sr.client_photo_url), '') IS NOT NULL
        -- to_jsonb: la columna puede no existir aún si el panel no se abrió tras desplegar.
        AND COALESCE((to_jsonb(sr)->>'client_photo_public')::boolean, true)
        AND COALESCE(NULLIF(BTRIM(sr.product_title), ''), p.title) IS NOT NULL
      ORDER BY sr.sold_at DESC, sr.created_at DESC
      LIMIT 24
    `).catch((error: { code?: string }) => {
      if (error.code === '42P01' || error.code === '42703') return [];
      throw error;
    });
    const clients = await this.productRepo.manager.query(`
      SELECT id::text, client_photo_url AS "photoUrl", product_title AS "productTitle",
        NULLIF(BTRIM(to_jsonb(possible_clients)->>'product_image_url'), '') AS "productImageUrl",
        NULL::text AS "category",
        purchased_at AS "purchasedAt"
      FROM possible_clients
      WHERE status = 'purchased' AND sale_id IS NULL
        AND NULLIF(BTRIM(client_photo_url), '') IS NOT NULL
        AND NULLIF(BTRIM(product_title), '') IS NOT NULL
      ORDER BY purchased_at DESC NULLS LAST, created_at DESC
      LIMIT 24
    `).catch((error: { code?: string }) => {
      if (error.code === '42P01' || error.code === '42703') return [];
      throw error;
    });
    const items = [...sales, ...clients]
      .sort((a, b) => new Date(b.purchasedAt).getTime() - new Date(a.purchasedAt).getTime())
      .slice(0, 24)
      // Solo la foto y el equipo comprado: nunca nombre, teléfono ni precio pagado.
      .map(({ id, photoUrl, productTitle, productImageUrl, category, purchasedAt }) => ({
        id,
        photoUrl,
        productTitle,
        productImageUrl: productImageUrl || null,
        category: category ? publicCategoryGroup(category) : null,
        purchasedMonth: purchasedAt ? new Date(purchasedAt).toISOString().slice(0, 7) : null,
      }));
    return { items };
  }

  private parseNotes(row: any) {
    return parseRowNotes(row);
  }

  private publicNotes(staged: StagedProduct | null) {
    return publicNotes(staged);
  }

  private publicProduct(product: CatalogProduct | null) {
    return publicProduct(product);
  }

  private publicStaged(staged: StagedProduct | null) {
    return publicStaged(staged);
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

  private compactRow(pub: CatalogPublic, product: CatalogProduct | undefined, staged: StagedProduct | undefined, availabilityOverride?: PublicAvailability) {
    const img = (Array.isArray(pub.images) && pub.images[0]) || (Array.isArray(staged?.images) && staged?.images[0]) || '/placeholder.svg';
    const { condition, saleType, price, compareAt, discount, discountMode, promoLabel } = this.priceMeta(product, staged);
    const notes = this.parseNotes(staged);
    const detail = notes?.specs?.detalle || notes?.detalle || {};
    const detailImages = Array.from(new Set([
      ...(Array.isArray(notes?.detailImages) ? notes.detailImages : []),
      ...(Array.isArray(notes?.detailPhotos) ? notes.detailPhotos : []),
      ...(Array.isArray(detail?.detailImages) ? detail.detailImages : []),
    ].map((value) => String(value || '').trim()).filter(Boolean)));
    const conditionDescription = String(detail?.detalles || detail?.productDetails || notes?.productDetails || notes?.detalles || '').trim();
    const stock = Number(product?.stock ?? staged?.stock ?? 0);
    // Sin el dato de reservas (pruebas o llamadas sueltas) se calcula con el stock recibido.
    const availability = availabilityOverride || publicAvailability(product, staged, 0, saleType);
    const available = Boolean(pub.is_published) && isSellable(availability);
    const batteryHealth = product?.battery_health ?? staged?.battery_health ?? notes?.batteryHealth ?? notes?.bateria?.salud ?? null;
    const includesValue = product?.includes || staged?.includes || notes?.includes || '';
    const includesExtra = product?.includes_extra || staged?.includes_extra || notes?.includesExtra || '';
    const includesDisplay = includesValue && includesValue !== 'Ninguno'
      ? (includesValue === 'Otros' ? includesExtra : includesValue)
      : '';
    const colorName = normalizeColorName(product?.color || staged?.color || notes?.color || '');
    const variantLabel = [
      colorName,
      batteryHealth ? `${batteryHealth}% bateria` : '',
      includesDisplay,
    ].filter(Boolean).join(' · ');
    return {
      id: pub.id,
      product_id: pub.product_id,
      slug: pub.slug,
      category: publicCategoryGroup(pub.category),
      image: img,
      images: Array.isArray(pub.images) ? pub.images : [],
      title: normalizeAppleTitle(product?.title || staged?.title || pub.slug),
      condition,
      saleType,
      discount,
      discountMode,
      promoLabel,
      price,
      compareAt,
      status: product?.status || null,
      stock: Number.isFinite(stock) ? stock : 0,
      available,
      availability,
      availabilityLabel: AVAILABILITY_LABEL[availability],
      variantGroup: product?.variant_group || staged?.variant_group || notes?.variantGroup || notes?.variant_group || null,
      variantLabel,
      color: colorName || null,
      batteryHealth,
      batteryCycles: product?.battery_cycles ?? staged?.battery_cycles ?? notes?.batteryCycles ?? notes?.bateria?.ciclos ?? null,
      processor: detail?.procesador || null,
      ram: detail?.ram || null,
      storage: detail?.almacenamiento || detail?.ssd || product?.storage_gb || staged?.storage_gb || notes?.storageGb || notes?.storage || null,
      detailCount: detailImages.length,
      hasConditionDetails: Boolean(conditionDescription || detailImages.length),
      includes: includesDisplay || null,
    };
  }

  /**
   * Producto, reservas vigentes y ficha staged de cada publicación. Las cuatro
   * lecturas solo dependen de los ids de producto, así que van en paralelo: una
   * ida a la base en lugar de varias en serie (~85 ms cada una hasta Neon).
   * La ficha se vincula por el SKU del producto y, si no hay, por source_id.
   */
  private async hydratePublicRows(pubs: CatalogPublic[], preferSourceIds: string[] = []): Promise<HydratedRow[]> {
    const productIds = Array.from(new Set(pubs.map((pub) => pub.product_id).filter(Boolean)));
    const [products, reserved, stagedBySku, stagedByPid] = productIds.length
      ? await Promise.all([
          this.productRepo.findBy({ id: In(productIds) }),
          reservedQtyByProduct(this.productRepo.manager, productIds),
          this.stagedRepo
            .createQueryBuilder('staged')
            .where(
              `staged.sku IN (SELECT product.sku FROM products product WHERE product.id IN (:...productIds) AND product.sku IS NOT NULL AND product.sku <> '')`,
              { productIds },
            )
            .getMany(),
          this.stagedRepo.findBy({ source_id: In(productIds) }),
        ])
      : ([[], new Map<string, number>(), [], []] as [CatalogProduct[], Map<string, number>, StagedProduct[], StagedProduct[]]);
    // Stock real antes de descontar reservas: distingue «reservado» de «vendido».
    const rawStock = new Map(products.map((product) => [product.id, product.stock] as const));
    applyReservedQty(products, reserved);
    const productById = new Map(products.map((product) => [product.id, product] as const));

    const stagedBySkuMap = new Map(stagedBySku.map((row) => [row.sku, row] as const));
    const stagedByPidMap = new Map(stagedByPid.map((row) => [row.source_id, row] as const));

    return pubs.map((pub) => {
      const product = productById.get(pub.product_id);
      const bySource = stagedByPidMap.get(pub.product_id);
      const bySku = product?.sku ? stagedBySkuMap.get(product.sku) : undefined;
      const staged = preferSourceIds.includes(pub.product_id) ? bySource || bySku : bySku || bySource;
      const availability = publicAvailability(
        product ? { status: product.status, stock: rawStock.get(product.id), sale_type: product.sale_type } : undefined,
        staged,
        reserved.get(pub.product_id) || 0,
        this.priceMeta(product, staged).saleType,
      );
      return { pub, product, staged, availability };
    });
  }

  private ensureCatalogViewsTable() {
    return runOnce('catalog:catalog_views', async () => {
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
    });
  }

  @Get()
  async list(@Query('q') q?: string, @Query('category') category?: string) {
    const where: any = { is_published: true };
    if (category === 'otros') {
      where.category = Not(In(['macbook', 'ipad', 'iphone', 'watch']));
    } else if (category) {
      where.category = category;
    }
    const order = { sort_order: 'ASC' as any, created_at: 'DESC' as any };
    const pubs = await this.publicRepo.find({ where, order });
    // Stock disponible = stock - reservas vigentes de solicitudes.
    const rows = await this.hydratePublicRows(pubs);

    const items = rows
      // Solo unidades que se pueden solicitar: sin vendidas, agotadas ni reservadas.
      .filter((row) => isSellable(row.availability))
      .map(({ pub: p, product, staged, availability }) => {
        return {
          id: p.id,
          product_id: p.product_id,
          slug: p.slug,
          category: publicCategoryGroup(p.category),
          createdAt: p.created_at,
          images: Array.isArray(p.images) ? p.images : [],
          product: this.publicProduct(product || null),
          staged: this.publicStaged(staged || null),
          availability,
        };
      })
      .filter((row) => (q ? String(row.product?.title || '').toLowerCase().includes(String(q).toLowerCase()) : true));
    return { items };
  }

  @Get('home')
  async home() {
    const pubs = await this.publicRepo.find({
      where: { is_published: true },
      order: { sort_order: 'ASC' as any, created_at: 'DESC' as any },
    });
    // Stock disponible = stock - reservas vigentes de solicitudes.
    const rows = (await this.hydratePublicRows(pubs)).filter((row) => isSellable(row.availability));

    const categories = new Map<string, { key: string; total: number; minPrice: number | null }>();
    for (const row of rows) {
      const key = publicCategoryGroup(row.pub.category);
      if (!key) continue;
      const current = categories.get(key) || { key, total: 0, minPrice: null };
      const price = this.priceMeta(row.product, row.staged).price;
      current.total += 1;
      if (price > 0 && Number(row.product?.stock ?? row.staged?.stock ?? 0) > 0 && (current.minPrice === null || price < current.minPrice)) current.minPrice = price;
      categories.set(key, current);
    }

    const bestRows = rows.filter((row) => Number(row.product?.stock ?? row.staged?.stock ?? 0) > 0).sort((a, b) => {
      const aTime = new Date(a.pub.created_at || 0).getTime() || 0;
      const bTime = new Date(b.pub.created_at || 0).getTime() || 0;
      return bTime - aTime;
    });

    const items = bestRows.slice(0, 8).map((row) => this.compactRow(row.pub, row.product, row.staged, row.availability));
    const featured = bestRows
      .filter((row) => this.priceMeta(row.product, row.staged).saleType !== 'PREVENTA')
      .slice(0, 4)
      .map((row) => this.compactRow(row.pub, row.product, row.staged, row.availability));

    // Promociones reales (precio rebajado sobre un precio anterior) para las campañas de la portada.
    const promotions = bestRows
      .map((row) => ({ row, meta: this.priceMeta(row.product, row.staged) }))
      .filter(({ meta }) => meta.saleType === 'PROMOCION' && meta.price > 0 && Number(meta.compareAt) > meta.price)
      .slice(0, 6)
      .map(({ row }) => this.compactRow(row.pub, row.product, row.staged, row.availability));

    const sellableRows = rows.filter((row) => Number(row.product?.stock ?? row.staged?.stock ?? 0) > 0 && this.priceMeta(row.product, row.staged).price > 0);
    const budgetBands = [
      { key: 'macbook-entry', category: 'macbook', label: 'MacBook hasta S/ 2,500', max: 2500 },
      { key: 'macbook-mid', category: 'macbook', label: 'MacBook de S/ 2,500 a S/ 4,000', min: 2500, max: 4000 },
      { key: 'iphone-entry', category: 'iphone', label: 'iPhone hasta S/ 2,000', max: 2000 },
      { key: 'premium', category: '', label: 'Equipos desde S/ 4,000', min: 4000 },
    ];
    const budgets = budgetBands.map((band) => ({
      ...band,
      count: sellableRows.filter((row) => {
        if (band.category && publicCategoryGroup(row.pub.category) !== band.category) return false;
        const totalWithIgv = this.priceMeta(row.product, row.staged).price * 1.18;
        return (band.min === undefined || totalWithIgv >= band.min) && (band.max === undefined || totalWithIgv <= band.max);
      }).length,
    })).filter((band) => band.count > 0);

    return { items, featured, promotions, categories: Array.from(categories.values()), budgets };
  }

  // Comparación: una lectura de publicaciones y una hidratación en lote,
  // sin galerías completas ni consultas de variantes por cada equipo.
  @Get('compare')
  async compare(@Query('items') raw = '') {
    const slugs = Array.from(new Set(String(raw).split(',').map(value => value.trim()).filter(value => value && value.length <= 200))).slice(0, 3);
    if (!slugs.length) return { items: [] };
    const pubs = await this.publicRepo.find({ where: { is_published: true, slug: In(slugs) } });
    const hydrated = await this.hydratePublicRows(pubs, pubs.map(pub => pub.product_id));
    const bySlug = new Map(hydrated.map(row => [row.pub.slug, row]));
    return { items: slugs.flatMap(slug => {
      const row = bySlug.get(slug);
      if (!row) return [];
      const staged = this.publicStaged(row.staged || null);
      // Solo datos públicos. Los detalles estéticos se comparan por su texto;
      // las fotos completas se consultan en la ficha.
      const notes = staged?.notes ? { ...staged.notes, detailImages: undefined, detailPhotos: undefined } : {};
      if (notes.detalle) notes.detalle = { ...notes.detalle, detailImages: undefined };
      if (notes.specs?.detalle) notes.specs = { ...notes.specs, detalle: { ...notes.specs.detalle, detailImages: undefined } };
      return [{ slug, category: publicCategoryGroup(row.pub.category), images: [row.pub.images?.[0] || row.staged?.images?.[0] || '/placeholder.svg'],
        product: this.publicProduct(row.product || null), staged: staged ? { ...staged, images: undefined, notes } : null,
        availability: row.availability, availabilityLabel: AVAILABILITY_LABEL[row.availability] }];
    }) };
  }

  @Get(':slug')
  async getOne(@Param('slug') slug: string) {
    // Una sola lectura de lo publicado da la unidad y sus hermanas: buscar
    // primero la unidad y luego su categoría eran dos viajes seguidos a la base.
    const published = await this.publicRepo.find({ where: { is_published: true as any }, order: { sort_order: 'ASC' as any, created_at: 'DESC' as any } });
    let pub = published.find((row) => row.slug === slug) || null;
    if (!pub) {
      const legacySku = slug.match(/-(svc-\d+)$/i)?.[1];
      if (legacySku) {
        const legacyProduct = await this.productRepo
          .createQueryBuilder('product')
          .where('LOWER(product.sku) = LOWER(:sku)', { sku: legacySku })
          .getOne();
        if (legacyProduct) pub = published.find((row) => row.product_id === legacyProduct.id) || null;
      }
    }
    if (!pub) throw new NotFoundException('not found');
    // La misma lectura alimenta la unidad y sus variantes: antes la unidad
    // se hidrataba dos veces y se repetían producto, staged y reservas.
    const category = publicCategoryGroup(pub.category);
    const sameCategory = published.filter((row) => category === 'otros'
      ? row.category != null && !['macbook', 'ipad', 'iphone', 'watch'].includes(row.category) // igual que Not(In(...)) en SQL
      : row.category === pub!.category);
    const siblings = await this.hydratePublicRows(sameCategory, [pub.product_id]);
    const own = siblings.find(row => row.pub.id === pub!.id);
    if (!own) throw new NotFoundException('not found');
    const product = own.product || null, staged = own.staged || null, availability = own.availability;

    // Otras unidades del mismo modelo: misma categoría y misma clave de familia
    // (ver utils/catalog-family). Solo unidades que se pueden solicitar, más la
    // actual. Una sola lectura de la categoría, hidratada en lote (sin N+1).
    const ownKey = familyKey(category, product, staged);
    let variants: any[] = [];
    if (ownKey) {
      variants = siblings
        .filter((row) => row.pub.id === pub.id || isSellable(row.availability))
        .filter((row) => familyKey(category, row.product, row.staged) === ownKey)
        .map((row) => this.compactRow(row.pub, row.product, row.staged, row.pub.id === pub.id ? availability : row.availability))
        .sort((a: any, b: any) => Number(a.price || 0) - Number(b.price || 0) || String(a.slug).localeCompare(String(b.slug)));
    }
    // Una sola unidad (la actual) no es una elección: no se envía lista.
    if (variants.length < 2) variants = [];

    return {
      item: {
        id: pub.id,
        product_id: pub.product_id,
        slug: pub.slug,
        category: publicCategoryGroup(pub.category),
        images: pub.images,
        product: this.publicProduct(product),
        staged: this.publicStaged(staged),
        availability,
        availabilityLabel: AVAILABILITY_LABEL[availability],
        familyKey: ownKey || null,
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
