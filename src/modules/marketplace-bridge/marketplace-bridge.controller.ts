import { BadRequestException, Body, Controller, Get, Header, Headers, NotFoundException, Param, Post, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { AuthService } from '../auth/auth.service';

type MarketplacePayload = {
  sku: string;
  titulo: string;
  precio: string;
  descripcion: string;
  etiquetas: string[];
  categoriaMarketplace: string;
  estadoMarketplace: string;
  images: string[];
};

function requiredText(value: unknown, name: string, maxLength: number) {
  const result = String(value ?? '').trim();
  if (!result) throw new BadRequestException(`${name} is required`);
  if (result.length > maxLength) throw new BadRequestException(`${name} is too long`);
  return result;
}

function marketplacePayload(value: unknown): MarketplacePayload {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const etiquetas = Array.isArray(body.etiquetas)
    ? Array.from(new Set(body.etiquetas.map((tag) => String(tag ?? '').trim()).filter(Boolean))).slice(0, 30)
    : [];
  const images = Array.isArray(body.images)
    ? Array.from(new Set(body.images.map((url) => String(url ?? '').trim()).filter((url) => /^https?:\/\//i.test(url) && url.length <= 2000)))
    : [];
  return {
    sku: requiredText(body.sku, 'sku', 100),
    titulo: requiredText(body.titulo, 'titulo', 300),
    precio: requiredText(body.precio, 'precio', 30),
    descripcion: requiredText(body.descripcion, 'descripcion', 12000),
    etiquetas,
    categoriaMarketplace: requiredText(body.categoriaMarketplace, 'categoriaMarketplace', 100),
    estadoMarketplace: requiredText(body.estadoMarketplace, 'estadoMarketplace', 100),
    images,
  };
}

@Controller('marketplace-bridge')
export class MarketplaceBridgeController {
  private tableReady: Promise<void> | null = null;

  constructor(
    private auth: AuthService,
    @InjectRepository(CatalogProduct) private productRepo: Repository<CatalogProduct>,
  ) {}

  private requireStaff(authHeader?: string) {
    const token = String(authHeader || '').startsWith('Bearer ') ? String(authHeader).substring(7) : '';
    if (!token) throw new UnauthorizedException();
    const user = this.auth.verifyToken(token);
    if (!['ADMIN', 'VENDEDOR'].includes(String(user.role || '').toUpperCase())) throw new UnauthorizedException();
    return user;
  }

  private ensureTable() {
    if (!this.tableReady) {
      this.tableReady = (async () => {
        await this.productRepo.manager.query(`
          CREATE TABLE IF NOT EXISTS marketplace_bridge_items (
            token uuid PRIMARY KEY,
            payload jsonb NOT NULL,
            created_by integer NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz NOT NULL
          )
        `);
        await this.productRepo.manager.query(`
          CREATE INDEX IF NOT EXISTS idx_marketplace_bridge_expires_at
          ON marketplace_bridge_items (expires_at)
        `);
      })();
    }
    return this.tableReady;
  }

  @Post()
  async prepare(@Headers('authorization') authHeader: string, @Body() body: unknown) {
    const user = this.requireStaff(authHeader);
    const payload = marketplacePayload(body);
    if (!/^\d+$/.test(payload.precio)) throw new BadRequestException('precio must contain only digits');
    await this.ensureTable();
    const token = randomUUID();
    const rows = await this.productRepo.manager.query(
      `INSERT INTO marketplace_bridge_items (token, payload, created_by, expires_at)
       VALUES ($1, $2::jsonb, $3, now() + interval '24 hours')
       RETURNING token, expires_at`,
      [token, JSON.stringify(payload), user.sub],
    );
    await this.productRepo.manager.query(`DELETE FROM marketplace_bridge_items WHERE expires_at <= now()`);
    return { token: rows[0].token, expiresAt: rows[0].expires_at };
  }

  @Get('latest')
  @Header('Cache-Control', 'no-store')
  async getLatest() {
    await this.ensureTable();
    const rows = await this.productRepo.manager.query(
      `SELECT token, payload, created_at, expires_at
       FROM marketplace_bridge_items
       WHERE expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    if (!rows[0]) throw new NotFoundException('No prepared Marketplace product is available');
    return {
      token: rows[0].token,
      data: rows[0].payload,
      preparedAt: rows[0].created_at,
      expiresAt: rows[0].expires_at,
    };
  }

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  async getPrepared(@Param('token') token: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      throw new NotFoundException();
    }
    await this.ensureTable();
    const rows = await this.productRepo.manager.query(
      `SELECT payload, expires_at
       FROM marketplace_bridge_items
       WHERE token = $1 AND expires_at > now()
       LIMIT 1`,
      [token],
    );
    if (!rows[0]) throw new NotFoundException('Marketplace product not found or expired');
    return { data: rows[0].payload, expiresAt: rows[0].expires_at };
  }
}
