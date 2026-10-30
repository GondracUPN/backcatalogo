import { BadRequestException, Body, ConflictException, Controller, Get, Header, Headers, HttpException, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { requireRole } from '../../utils/staff-auth';
import { isSellable, publicAvailability } from '../../utils/catalog-family';
import { reservedQtyByProduct } from '../../utils/stock-reservations';
import { AuthService } from '../auth/auth.service';

export function normalizedMarketplaceTitle(value: string) {
  // Conserva modelo, números, color y especificaciones: no hay búsqueda difusa.
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/^remato\s+/, '').replace(/(\d)\s+(gb|tb)\b/g, '$1$2')
    .replace(/[“”″]/g, '"').replace(/\s+/g, ' ').trim();
}

function text(value: unknown, name: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw new BadRequestException(`Invalid ${name}`);
  }
  return value.trim();
}

export function skuCandidates(value: string) {
  const numeric = value.match(/^(?:SKU\s+)?(?:MS-)?(\d+)$/i)?.[1];
  // Solo el formato MS-numérico de Servicios tiene alias. No se convierte a Number.
  // Incluye el valor literal para detectar una eventual colisión con el alias.
  return numeric ? [...new Set([numeric, `MS-${numeric}`, `ms-${numeric}`, value])] : [value];
}

function containsKnownSpecs(title: string, row: any, notes: any) {
  const compact = title.replace(/\s+/g, '');
  const detail = notes?.specs?.detalle || notes?.detalle || {};
  const includes = (value: unknown) => !value || compact.includes(normalizedMarketplaceTitle(String(value)).replace(/\s+/g, ''));
  const storage = Number(row.storage_gb || notes?.storageGb || 0);
  if (storage > 0 && !new RegExp(`(?:^|[^0-9])(?:${storage}gb${storage % 1024 === 0 ? `|${storage / 1024}tb` : ''})(?![a-z0-9])`).test(title)) return false;
  if (!includes(row.color || notes?.color) || !includes(row.iphone_model) || !includes(row.iphone_number)) return false;
  for (const value of [detail.procesador, detail.generacion, detail['tamaño'] || detail.tamanio || detail.tamano]) {
    if (!includes(value)) return false;
  }
  const ram = String(detail.ram || notes?.ram || '').match(/[0-9]+/)?.[0];
  if (ram && !new RegExp(`(?:^|[^0-9])${ram}\\s*(?:gb|ram)(?![a-z0-9])`).test(title)) return false;
  return true;
}

@Controller('admin/marketplace')
export class MarketplaceResolverController {
  private readonly attempts = new Map<number, { count: number; expires: number }>();
  private linksReady: Promise<void> | null = null;

  constructor(
    private readonly auth: AuthService,
    @InjectRepository(CatalogProduct) private readonly products: Repository<CatalogProduct>,
  ) {}

  private listingId(value: unknown) {
    const id = text(value, 'listingId', 25);
    if (!/^\d{5,25}$/.test(id)) throw new BadRequestException('Invalid listingId');
    return id;
  }

  private ensureLinks() {
    if (!this.linksReady) this.linksReady = (async () => {
      await this.products.manager.query(`CREATE TABLE IF NOT EXISTS marketplace_listing_links (
        listing_id text PRIMARY KEY,
        product_id uuid NULL REFERENCES products(id) ON DELETE SET NULL,
        sku text NOT NULL, title_key text NULL, price text NULL,
        created_by integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await this.products.manager.query(`CREATE INDEX IF NOT EXISTS marketplace_listing_links_product_idx ON marketplace_listing_links(product_id)`);
    })().catch(error => { this.linksReady = null; throw error; });
    return this.linksReady;
  }

  @Get('listings/:listingId')
  @Header('Cache-Control', 'private, no-store')
  async linkedListing(@Headers('authorization') authorization: string, @Param('listingId') rawId: string, @Query() query: Record<string, unknown>) {
    requireRole(this.auth, authorization, ['ADMIN']);
    const id = this.listingId(rawId);
    if (Object.keys(query).some(key => !['sku', 'title', 'price', 'productId'].includes(key))) throw new BadRequestException('Unknown query parameter');
    for (const [key, value] of Object.entries(query)) text(value, key, key === 'title' ? 300 : 100);
    let rows: any[];
    try { rows = await this.products.manager.query('SELECT product_id, sku, title_key, price FROM marketplace_listing_links WHERE listing_id = $1', [id]); }
    catch (error: any) { if (error.code === '42P01') throw new NotFoundException('Listing is not linked'); throw error; }
    const link = rows[0];
    if (!link) throw new NotFoundException('Listing is not linked');
    if (!link.product_id) throw new ConflictException({ code: 'LISTING_PRODUCT_REMOVED', message: 'El equipo vinculado a este anuncio fue eliminado. No se asociará a otro equipo automáticamente.' });
    const sameSku = typeof query.sku === 'string' && skuCandidates(query.sku).includes(link.sku);
    const sameProduct = typeof query.productId === 'string' && query.productId === link.product_id;
    const sameTitlePrice = typeof query.title === 'string' && typeof query.price === 'string'
      && normalizedMarketplaceTitle(query.title) === link.title_key && query.price === link.price;
    if (!sameSku && !sameProduct && !sameTitlePrice) throw new ConflictException({ code: 'LISTING_EVIDENCE_CHANGED', message: 'El anuncio cambió; se debe verificar de nuevo antes de usar su vínculo.' });
    const resolved = await this.resolve(authorization, { productId: link.product_id });
    if (resolved.product.sku !== link.sku) throw new ConflictException('Linked product SKU changed');
    return { ...resolved, linked: true };
  }

  @Post('listings')
  @Header('Cache-Control', 'private, no-store')
  async linkListing(@Headers('authorization') authorization: string, @Body() body: Record<string, unknown>) {
    const user = requireRole(this.auth, authorization, ['ADMIN']);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['listingId', 'sku', 'url', 'title', 'price'].includes(key))) throw new BadRequestException('Invalid link body');
    const id = this.listingId(body.listingId);
    const sku = text(body.sku, 'sku', 100);
    const url = text(body.url, 'url', 1000);
    let slug: string;
    try {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://www.macsomenos.com' || !/^\/product\/[^/]+$/.test(parsed.pathname) || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error();
      slug = decodeURIComponent(parsed.pathname.slice('/product/'.length));
    } catch { throw new BadRequestException('Invalid product URL'); }
    const title = body.title === undefined ? null : text(body.title, 'title', 300);
    const price = body.price === undefined ? null : text(body.price, 'price', 12);
    if (price !== null && !/^\d{1,9}$/.test(price)) throw new BadRequestException('Invalid price');
    const pubs = await this.products.manager.query('SELECT product_id FROM catalog_public WHERE slug = $1 AND is_published = true', [slug]);
    if (!pubs[0]) throw new NotFoundException('Published product not found');
    const resolved = await this.resolve(authorization, { productId: pubs[0].product_id });
    if (!skuCandidates(sku).includes(resolved.product.sku) || resolved.product.url !== url) throw new ConflictException('Product URL and SKU do not agree');
    if (!resolved.product.available) throw new ConflictException('Product is unavailable');
    await this.ensureLinks();
    const rows = await this.products.manager.query(`INSERT INTO marketplace_listing_links
        (listing_id, product_id, sku, title_key, price, created_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (listing_id) DO UPDATE SET title_key = EXCLUDED.title_key, price = EXCLUDED.price, updated_at = now()
        WHERE marketplace_listing_links.product_id = EXCLUDED.product_id AND marketplace_listing_links.sku = EXCLUDED.sku
      RETURNING listing_id`, [id, pubs[0].product_id, resolved.product.sku, title ? normalizedMarketplaceTitle(title) : null, price, user.sub]);
    if (!rows[0]) throw new ConflictException({ code: 'LISTING_LINK_CONFLICT', message: 'Este anuncio ya está vinculado a otro equipo. No se cambiará la asociación ni se enviará otro producto automáticamente.' });
    return { linked: true, listingId: id, product: resolved.product };
  }

  @Get('resolve')
  @Header('Cache-Control', 'private, no-store')
  async resolve(@Headers('authorization') authorization: string, @Query() query: Record<string, unknown>) {
    const user = requireRole(this.auth, authorization, ['ADMIN']);
    const now = Date.now();
    for (const [key, entry] of this.attempts) if (entry.expires <= now) this.attempts.delete(key);
    const key = Number(user.sub);
    const attempt = this.attempts.get(key) || { count: 0, expires: now + 60_000 };
    this.attempts.set(key, attempt);
    if (++attempt.count > 60) throw new HttpException('Too many resolver requests', 429);
    if (Object.keys(query).some((key) => !['sku', 'productId', 'title', 'price'].includes(key))) {
      throw new BadRequestException('Unknown query parameter');
    }
    for (const [name, value] of Object.entries(query)) {
      text(value, name, name === 'title' ? 300 : name === 'productId' ? 36 : name === 'price' ? 12 : 100);
    }
    let predicate: string;
    let params: unknown[];
    let title: string | undefined;
    let price: number | undefined;
    if (query.sku !== undefined) {
      params = [skuCandidates(text(query.sku, 'sku', 100))];
      predicate = 'p.sku = ANY($1::text[])';
    } else if (query.productId !== undefined) {
      const id = text(query.productId, 'productId', 36);
      if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) throw new BadRequestException('Invalid productId');
      params = [id];
      predicate = 'p.id = $1::uuid';
    } else {
      title = normalizedMarketplaceTitle(text(query.title, 'title', 300));
      const rawPrice = text(query.price, 'price', 12);
      if (!/^\d{1,9}(?:\.0{1,2})?$/.test(rawPrice) || Number(rawPrice) <= 0) throw new BadRequestException('Invalid price');
      price = Number(rawPrice);
      // El publicador trunca el precio final (o precio base). La igualdad del
      // título completo se verifica después; nunca se descartan especificaciones.
      params = [price];
      predicate = `(trunc(p.price) = $1 OR trunc(p.final_price) = $1 OR trunc(s.final_price) = $1
        OR trunc(substring(s.notes FROM '"finalPrice"[[:space:]]*:[[:space:]]*"?([0-9]+(?:[.][0-9]+)?)')::numeric) = $1)`;
    }
    const rows = await this.products.manager.query(`
      SELECT p.id, p.sku, p.title, p.price, p.final_price, p.status, p.stock, p.sale_type,
        p.storage_gb, p.color, p.iphone_model, p.iphone_number,
        cp.slug, s.status AS staged_status, s.sale_type AS staged_sale_type,
        s.final_price AS staged_final_price, s.notes
      FROM products p
      JOIN catalog_public cp ON cp.product_id = p.id AND cp.is_published = true
      LEFT JOIN LATERAL (
        SELECT sp.status, sp.sale_type, sp.final_price, sp.notes, sp.owner_user_id
        FROM staged_products sp WHERE sp.sku = p.sku OR sp.source_id = p.id
        ORDER BY (sp.sku = p.sku) DESC, sp.id LIMIT 1
      ) s ON true
      WHERE p.status IN ('listed', 'sold') AND COALESCE(s.status, 'listed') IN ('listed', 'published', 'sold')
        AND s.owner_user_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM staged_products own
          WHERE (own.sku = p.sku OR own.source_id = p.id) AND own.owner_user_id IS NOT NULL)
        AND ${predicate}
      LIMIT 101`, params);
    // No elegir una unidad sobre una muestra truncada.
    if (rows.length > 100) throw new ConflictException('Too many candidates; use SKU');
    const reserved = await reservedQtyByProduct(this.products.manager, rows.map((row: any) => row.id));
    const matches = rows.flatMap((row: any) => {
      let notes: any = {};
      try { notes = JSON.parse(row.notes || '{}'); } catch { /* notas históricas */ }
      const availability = publicAvailability(row, { status: row.staged_status, sale_type: row.staged_sale_type }, reserved.get(row.id) || 0, row.sale_type || row.staged_sale_type || notes?.saleType);
      if (title !== undefined) {
        const marketplacePrice = [row.final_price ?? row.staged_final_price, notes?.finalPrice, row.price]
          .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
          .map(Number).find((v) => Number.isFinite(v) && v > 0) || 0;
        if (!isSellable(availability) || normalizedMarketplaceTitle(row.title) !== title
          || !containsKnownSpecs(title, row, notes) || Math.trunc(marketplacePrice) !== price) return [];
      }
      return [{ sku: row.sku.replace(/^MS-(?=\d+$)/i, ''), title: row.title,
        url: `https://www.macsomenos.com/product/${encodeURIComponent(row.slug)}`,
        available: isSellable(availability), availability }];
    });
    if (!matches.length) throw new NotFoundException('No verifiable published product');
    if (matches.length !== 1) throw new ConflictException('Ambiguous product; use exact productId');
    return { found: true, product: matches[0] };
  }
}
