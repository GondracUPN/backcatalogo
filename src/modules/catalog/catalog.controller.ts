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
