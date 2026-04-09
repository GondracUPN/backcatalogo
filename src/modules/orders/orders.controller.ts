import { BadRequestException, Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { Order } from '../../entities/order.entity';
import { AuthService } from '../auth/auth.service';

@Controller('orders')
export class OrdersController {
  constructor(
    private auth: AuthService,
    @InjectRepository(CatalogProduct) private products: Repository<CatalogProduct>,
    @InjectRepository(Order) private orders: Repository<Order>,
  ) {}

  private requireAuth(authHeader?: string) {
    const token = (authHeader || '').startsWith('Bearer ') ? (authHeader || '').substring(7) : undefined;
    if (!token) throw new UnauthorizedException();
    const payload = this.auth.verifyToken(token);
    if (!payload) throw new UnauthorizedException();
    return payload;
  }

  @Post('reserve')
  async reserve(@Headers('authorization') authHeader: string, @Body() body: any) {
    this.requireAuth(authHeader);
    const productId = String(body?.productId || '');
    const qty = Number(body?.qty || 0);
    if (!productId || qty <= 0) throw new BadRequestException('invalid payload');

    const res = await this.products.query(
      `UPDATE products
         SET stock = stock - $1,
             status = CASE WHEN stock - $1 <= 0 THEN 'sold' ELSE status END,
             updated_at = NOW()
       WHERE id = $2
         AND stock >= $1
         AND status = 'listed'
       RETURNING id, stock, status` as any,
      [qty, productId],
    );
    const row = res?.[0];
    if (!row) return { ok: false, status: 409, message: 'Out of stock' };
    await this.orders.save(this.orders.create({ product_id: productId, qty }));
    if (Number(row.stock) === 0) {
      // TODO: emit product.sold webhook if needed
    }
    return { ok: true, product: row };
  }
}

