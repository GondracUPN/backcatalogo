import { BadRequestException, ConflictException, Controller, Get, Header, Headers, HttpException, NotFoundException, Query } from '@nestjs/common';
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

  constructor(
    private readonly auth: AuthService,
    @InjectRepository(CatalogProduct) private readonly products: Repository<CatalogProduct>,
  ) {}

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
