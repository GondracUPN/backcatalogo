import { BadRequestException, Body, Controller, Get, Headers, Post, Query, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { CartItem } from '../../entities/cart-item.entity';
import { OfferAttempt } from '../../entities/offer-attempt.entity';
import { OfferSubmitDto } from '../../dtos/offers.dto';

const MAX_ATTEMPTS = 3;

@Controller('offers')
export class OffersController {
  constructor(
    @InjectRepository(CatalogProduct) private products: Repository<CatalogProduct>,
    @InjectRepository(CartItem) private cartItems: Repository<CartItem>,
    @InjectRepository(OfferAttempt) private offerAttempts: Repository<OfferAttempt>,
  ) {}

  private async refreshSessionCart(req: any, cartId: string) {
    if (!req?.session || !cartId) return;
    const items = await this.cartItems.find({ where: { cart_id: cartId }, order: { created_at: 'ASC' as any } });
    req.session.cartItems = items.map((it) => ({
      id: it.id,
      product_id: it.product_id,
      qty: it.qty,
      offer_price: it.offer_price ?? null,
    }));
  }

  private extractCartId(req: any, header?: string, body?: any, query?: any) {
    const byBody = body?.cartId || body?.cart_id;
    const byQuery = query?.cartId || query?.cart_id;
    const byHeader = header;
    const byCookie = req?.cookies?.cart_id;
    const bySession = req?.session?.cartId;
    if (byBody) return String(byBody);
    if (byQuery) return String(byQuery);
    if (byHeader) return String(byHeader);
    if (byCookie) return String(byCookie);
    if (bySession) return String(bySession);
    return '';
  }

  private extractFingerprint(req: any, header?: string, body?: any, query?: any) {
    const byHeader = header;
    const byBody = body?.fingerprint || body?.fp;
    const byQuery = query?.fingerprint || query?.fp;
    const byCookie = req?.cookies?.fp || req?.cookies?.fingerprint;
    if (byHeader) return String(byHeader);
    if (byBody) return String(byBody);
    if (byQuery) return String(byQuery);
    if (byCookie) return String(byCookie);
    return '';
  }

  private async findAttempt(productId: string, cartId: string, fingerprint: string) {
    const where: FindOptionsWhere<OfferAttempt>[] = [{ product_id: productId, fingerprint }];
    if (cartId) where.push({ product_id: productId, cart_id: cartId });
    return this.offerAttempts.findOne({
      where,
    });
  }

  @Get('status')
  async status(
    @Req() req: any,
    @Query('productId') productId?: string,
    @Headers('x-cart-id') xCartId?: string,
    @Headers('x-fingerprint') xFingerprint?: string,
  ) {
    const cartId = this.extractCartId(req, xCartId, undefined, { productId });
    const fingerprint = this.extractFingerprint(req, xFingerprint, undefined, { fingerprint: xFingerprint });
    if (!productId) throw new BadRequestException('missing productId');
    if (!cartId) throw new BadRequestException('missing cartId');
    if (!fingerprint) throw new BadRequestException('missing fingerprint');
    req.session.cartId = cartId;

    const attempt = await this.findAttempt(productId, cartId, fingerprint);
    const blocked = Boolean(attempt?.blocked);
    const attempts = Number(attempt?.attempts || 0);
    return { blocked, attempts, attemptsRemaining: blocked ? 0 : Math.max(0, MAX_ATTEMPTS - attempts) };
  }

  @Post('submit')
  async submit(
    @Req() req: any,
    @Body() body: OfferSubmitDto,
    @Headers('x-cart-id') xCartId?: string,
    @Headers('x-fingerprint') xFingerprint?: string,
  ) {
    const cartId = this.extractCartId(req, xCartId, body, undefined);
    const fingerprint = this.extractFingerprint(req, xFingerprint, body, undefined);
    if (!cartId) throw new BadRequestException('missing cartId');
    if (!fingerprint) throw new BadRequestException('missing fingerprint');
    req.session.cartId = cartId;
    const productId = String(body?.productId || '');
    if (!productId) throw new BadRequestException('missing productId');
    const offerNum = Number(body?.offer);
    if (!isFinite(offerNum)) throw new BadRequestException('invalid offer');

    const product = await this.products.findOne({ where: { id: productId } });
    if (!product) throw new BadRequestException('product not found');
    if (String(product.sale_type || '').toUpperCase() !== 'OFERTA') {
      throw new BadRequestException('product is not offer');
    }
    if (product.status === 'sold') throw new BadRequestException('product sold');
    if (Number(product.stock ?? 1) <= 0) throw new BadRequestException('product out of stock');

    const attempt = await this.findAttempt(productId, cartId, fingerprint);
    if (attempt?.blocked) {
      return { ok: false, blocked: true, attemptsRemaining: 0 };
    }

    const min = Number(product.min_offer_price || 0);
    const max = Number(product.price || 0);
    const isValid = isFinite(offerNum) && offerNum >= min && offerNum <= max;
    if (!isValid) {
      const nextAttempts = Number(attempt?.attempts || 0) + 1;
      const blocked = nextAttempts >= MAX_ATTEMPTS;
      await this.offerAttempts.save(
        this.offerAttempts.create({
          id: attempt?.id,
          product_id: productId,
          cart_id: cartId,
          fingerprint,
          attempts: nextAttempts,
          blocked,
        } as any),
      );
      return { ok: false, blocked, attemptsRemaining: blocked ? 0 : Math.max(0, MAX_ATTEMPTS - nextAttempts) };
    }

    const offer = Number(offerNum.toFixed(2));
    const existing = await this.cartItems.findOne({ where: { cart_id: cartId, product_id: productId } });
    if (existing) {
      existing.qty = Math.max(1, Number(existing.qty || 1));
      existing.offer_price = String(offer);
      await this.cartItems.save(existing);
      await this.refreshSessionCart(req, cartId);
      return { ok: true, item: existing, blocked: false, attemptsRemaining: Math.max(0, MAX_ATTEMPTS - Number(attempt?.attempts || 0)) };
    }

    const created = await this.cartItems.save(
      this.cartItems.create({ cart_id: cartId, product_id: productId, qty: 1, offer_price: String(offer) }),
    );
    if (!created?.id) {
      // eslint-disable-next-line no-console
      console.error('[offers] failed to persist cart item', { cartId, productId, offer });
      throw new BadRequestException('cart save failed');
    }
    await this.refreshSessionCart(req, cartId);
    return { ok: true, item: created, blocked: false, attemptsRemaining: Math.max(0, MAX_ATTEMPTS - Number(attempt?.attempts || 0)) };
  }
}
