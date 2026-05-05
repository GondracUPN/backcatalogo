import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { CatalogPublic } from '../../entities/catalog-public.entity';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { StagedProduct } from '../../entities/staged-product.entity';
import { CatalogView } from '../../entities/catalog-view.entity';

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

  private priceMeta(product: CatalogProduct | undefined, staged: StagedProduct | undefined) {
    const notes = this.parseNotes(staged);
    const saleType = String(product?.sale_type || staged?.sale_type || notes?.saleType || '').toUpperCase();
    const salePrice = Number(product?.price ?? staged?.price ?? 0);
    const discount = Number(product?.discount ?? staged?.discount ?? notes?.discount ?? notes?.descuentoPorc ?? 0);
    const finalPrice = product?.final_price ?? staged?.final_price ?? notes?.finalPrice ?? null;
    let price = salePrice;
    let compareAt: number | null = null;

    if (saleType === 'PROMOCION') {
      const computed = finalPrice !== null ? Number(finalPrice) : +(salePrice * (1 - discount / 100)).toFixed(2);
      if (isFinite(computed) && computed > 0) price = computed;
      compareAt = salePrice || null;
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

    return { condition, saleType, price: isFinite(price) ? price : 0, compareAt };
  }

  private compactRow(pub: CatalogPublic, product: CatalogProduct | undefined, staged: StagedProduct | undefined) {
    const img = (Array.isArray(pub.images) && pub.images[0]) || (Array.isArray(staged?.images) && staged?.images[0]) || '/placeholder.svg';
    const { condition, saleType, price, compareAt } = this.priceMeta(product, staged);
    return {
      id: pub.id,
      slug: pub.slug,
      category: pub.category,
      image: img,
      title: product?.title || staged?.title || pub.slug,
      created_at: pub.created_at,
      condition,
      saleType,
      price,
      compareAt,
    };
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
    // Cuando se filtra por categoría, mostrar más antiguos primero.
    const order = category
      ? ({ sort_order: 'ASC' as any, created_at: 'ASC' as any })
      : ({ sort_order: 'ASC' as any, created_at: 'DESC' as any });
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
        return { ...p, product, staged };
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

    const now = Date.now();
    const recent = rows.filter((row) => now - new Date(row.pub.created_at).getTime() <= 14 * 24 * 60 * 60 * 1000);
    const source = recent.length ? recent : rows;
    const items = source.slice(0, 8).map((row) => this.compactRow(row.pub, row.product, row.staged));

    return { items, categories: Array.from(categories.values()) };
  }

  @Get(':slug')
  async getOne(@Param('slug') slug: string) {
    const pub = await this.publicRepo.findOne({ where: { slug, is_published: true as any } });
    if (!pub) throw new NotFoundException('not found');
    const product = await this.productRepo.findOne({ where: { id: pub.product_id } });
    let staged: StagedProduct | null = null;
    if (product?.sku) staged = await this.stagedRepo.findOne({ where: { sku: product.sku } });
    if (!staged) staged = await this.stagedRepo.findOne({ where: { source_id: pub.product_id } });
    return { item: { ...pub, product, staged } };
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
