import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Post, Put, Query, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CartItem } from '../../entities/cart-item.entity';
import { CatalogPublic } from '../../entities/catalog-public.entity';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { StagedProduct } from '../../entities/staged-product.entity';
import { CartAddDto, CartUpdateDto } from '../../dtos/cart.dto';

@Controller('cart')
export class CartController {
  constructor(
    @InjectRepository(CartItem) private cartItems: Repository<CartItem>,
    @InjectRepository(CatalogProduct) private products: Repository<CatalogProduct>,
    @InjectRepository(CatalogPublic) private publicCatalog: Repository<CatalogPublic>,
    @InjectRepository(StagedProduct) private staged: Repository<StagedProduct>,
  ) {}

  private setSessionCartItems(req: any, items: CartItem[]) {
    if (!req?.session) return;
    req.session.cartItems = items.map((it) => ({
      id: it.id,
      product_id: it.product_id,
      qty: it.qty,
      offer_price: it.offer_price ?? null,
    }));
  }

  private async refreshSessionCart(req: any, cartId: string) {
    if (!req?.session || !cartId) return;
    const items = await this.cartItems.find({ where: { cart_id: cartId }, order: { created_at: 'ASC' as any } });
    this.setSessionCartItems(req, items);
  }

  private extractCartId(req: any, opts: { body?: any; query?: any; header?: string }) {
    const byBody = opts.body?.cartId || opts.body?.cart_id;
    const byQuery = opts.query?.cartId || opts.query?.cart_id;
    const byHeader = opts.header;
    const byCookie = req?.cookies?.cart_id;
    const bySession = req?.session?.cartId;
    if (byBody) return String(byBody);
    if (byQuery) return String(byQuery);
    if (byHeader) return String(byHeader);
    if (byCookie) return String(byCookie);
    if (bySession) return String(bySession);
    return '';
  }

  private parseNotes(notes: unknown) {
    try {
      if (!notes) return {};
      if (typeof notes === 'string') return JSON.parse(notes);
      if (typeof notes === 'object') return notes as Record<string, any>;
      return {};
    } catch {
      return {};
    }
  }

  private resolveRowPrice(row: CartItem, product: CatalogProduct | null, staged: StagedProduct | null) {
    const saleType = String(product?.sale_type || staged?.sale_type || '').toUpperCase();
    const salePrice = Number(product?.price ?? staged?.price ?? 0);
    if (row?.offer_price !== undefined && row?.offer_price !== null && row?.offer_price !== '') {
      const offer = Number(row.offer_price);
      if (isFinite(offer) && offer > 0) return offer;
    }
    const notes = this.parseNotes(staged?.notes);
    const discount = Number(product?.discount ?? staged?.discount ?? notes?.discount ?? notes?.descuentoPorc ?? 0);
    const finalPrice = product?.final_price ?? staged?.final_price ?? notes?.finalPrice ?? null;
    if (saleType === 'PROMOCION') {
      const mode = String(notes?.discountMode || notes?.discountType || 'percent').toLowerCase();
      const computed = finalPrice !== null ? Number(finalPrice) : +(mode === 'amount' ? Math.max(0, salePrice - discount) : salePrice * (1 - discount / 100)).toFixed(2);
      if (isFinite(computed) && computed > 0) return computed;
    }
    return salePrice;
  }

  private resolveRowColor(product: CatalogProduct | null, staged: StagedProduct | null) {
    const notes = this.parseNotes(staged?.notes);
    return String(product?.color || staged?.color || notes?.color || '').trim();
  }

  private resolveRequestType(row: CartItem, product: CatalogProduct | null, staged: StagedProduct | null) {
    const saleType = String(product?.sale_type || staged?.sale_type || '').toUpperCase();
    if (saleType === 'PREVENTA') return 'preventa';
    if (row?.offer_price !== undefined && row?.offer_price !== null && row?.offer_price !== '') {
      const offer = Number(row.offer_price);
      const listPrice = Number(product?.price ?? staged?.price ?? 0);
      if (isFinite(offer) && isFinite(listPrice) && offer < listPrice) return 'offer';
    }
    return 'purchase';
  }

  private assertAvailableQuantity(product: CatalogProduct, qty: number) {
    if (!Number.isInteger(qty) || qty < 1) throw new BadRequestException('invalid quantity');
    if (product.status === 'sold') throw new BadRequestException('product sold');
    const stock = Number(product.stock ?? 0);
    if (!Number.isFinite(stock) || stock <= 0) throw new BadRequestException('product out of stock');
    const isNew = String(product.product_condition || '').toLowerCase().includes('nuevo');
    const maxQty = isNew ? stock : 1;
    if (qty > maxQty) throw new BadRequestException('quantity exceeds stock');
  }

  private async ensureContactRequestsTable() {
    const mgr = this.cartItems.manager;
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

  @Get()
  async list(@Req() req: any, @Query() query: any, @Headers('x-cart-id') xCartId: string) {
    const cartId = this.extractCartId(req, { query, header: xCartId });
    if (!cartId) throw new BadRequestException('missing cartId');
    req.session.cartId = cartId;
    const items = await this.cartItems.find({ where: { cart_id: cartId }, order: { created_at: 'ASC' as any } });
    this.setSessionCartItems(req, items);
    if (!items.length) return { items: [] };

    const productIds = items.map((it) => it.product_id);
    const products = await this.products.findBy({ id: In(productIds) });
    const pMap = new Map(products.map((p) => [p.id, p] as const));

    const skus = products.map((p) => p.sku).filter(Boolean);
    const stagedBySku = skus.length ? await this.staged.findBy({ sku: In(skus) }) : [];
    const sBySku = new Map(stagedBySku.map((s) => [s.sku, s] as const));
    const publicItems = await this.publicCatalog.findBy({ product_id: In(productIds) });
    const pubByProductId = new Map(publicItems.map((p) => [p.product_id, p] as const));

    return {
      items: items.map((it) => {
        const prod = pMap.get(it.product_id);
        const staged = prod?.sku ? sBySku.get(prod.sku) : null;
        const pub = pubByProductId.get(it.product_id);
        return { ...it, product: prod || null, staged: staged || null, slug: pub?.slug || null };
      }),
    };
  }

  @Post('items')
  async add(@Req() req: any, @Body() body: CartAddDto, @Headers('x-cart-id') xCartId: string) {
    const cartId = this.extractCartId(req, { body, header: xCartId });
    if (!cartId) throw new BadRequestException('missing cartId');
    req.session.cartId = cartId;
    const productId = String(body?.productId || '');
    const qty = Number(body?.qty || 1);
    const offerPrice = body?.offerPrice;
    if (!productId) throw new BadRequestException('missing productId');

    const product = await this.products.findOne({ where: { id: productId } });
    if (!product) throw new BadRequestException('product not found');
    this.assertAvailableQuantity(product, qty);

    let offer: string | null = null;
    if (product.sale_type === 'OFERTA') {
      if (offerPrice === undefined || offerPrice === null) {
        throw new BadRequestException('offer required');
      }
      const offerNum = Number(offerPrice);
      const min = Number(product.min_offer_price || 0);
      const max = Number(product.price || 0);
      if (!isFinite(offerNum) || offerNum < min || offerNum > max) {
        throw new BadRequestException('offer out of range');
      }
      offer = Number(offerNum.toFixed(2)).toString();
    }

    const existing = await this.cartItems.findOne({ where: { cart_id: cartId, product_id: productId } });
    if (existing) {
      existing.qty = qty;
      existing.offer_price = offer;
      await this.cartItems.save(existing);
      await this.refreshSessionCart(req, cartId);
      return { ok: true, item: existing };
    }

    try {
      const created = await this.cartItems.save(this.cartItems.create({ cart_id: cartId, product_id: productId, qty, offer_price: offer }));
      if (!created?.id) {
        // eslint-disable-next-line no-console
        console.error('[cart] item not persisted', { cartId, productId });
        throw new BadRequestException('cart save failed');
      }
      await this.refreshSessionCart(req, cartId);
      return { ok: true, item: created };
    } catch (err) {
      // Posible carrera: insertar el mismo producto dos veces
      const fallback = await this.cartItems.findOne({ where: { cart_id: cartId, product_id: productId } });
      if (fallback) {
        fallback.qty = qty;
        fallback.offer_price = offer;
        await this.cartItems.save(fallback);
        await this.refreshSessionCart(req, cartId);
        return { ok: true, item: fallback };
      }
      // eslint-disable-next-line no-console
      console.error('[cart] failed to save item', err);
      throw err;
    }
  }

  @Put('items/:id')
  async updateQty(@Req() req: any, @Param('id') id: string, @Body() body: CartUpdateDto, @Headers('x-cart-id') xCartId: string) {
    const cartId = this.extractCartId(req, { body, header: xCartId });
    if (!cartId) throw new BadRequestException('missing cartId');
    req.session.cartId = cartId;
    const qty = Number(body?.qty || 0);
    const item = await this.cartItems.findOne({ where: { id, cart_id: cartId } });
    if (!item) throw new BadRequestException('not found');
    if (qty <= 0) {
      await this.cartItems.delete({ id });
      await this.refreshSessionCart(req, cartId);
      return { ok: true, deleted: true };
    }
    const product = await this.products.findOne({ where: { id: item.product_id } });
    if (!product) throw new BadRequestException('product not found');
    this.assertAvailableQuantity(product, qty);
    item.qty = qty;
    await this.cartItems.save(item);
    await this.refreshSessionCart(req, cartId);
    return { ok: true, item };
  }

  @Delete('items/:id')
  async remove(@Req() req: any, @Param('id') id: string, @Headers('x-cart-id') xCartId: string, @Body() body: any) {
    const cartId = this.extractCartId(req, { body, header: xCartId });
    if (!cartId) throw new BadRequestException('missing cartId');
    req.session.cartId = cartId;
    await this.cartItems.delete({ id, cart_id: cartId });
    await this.refreshSessionCart(req, cartId);
    return { ok: true };
  }

  @Post('contact-request')
  async contactRequest(@Req() req: any, @Body() body: any, @Headers('x-cart-id') xCartId: string) {
    const cartId = this.extractCartId(req, { body, header: xCartId });
    if (!cartId) throw new BadRequestException('missing cartId');
    req.session.cartId = cartId;

    const customerName = String(body?.name || body?.customerName || '').trim();
    const phoneDigits = String(body?.phone || body?.customerPhone || '').replace(/\D+/g, '');
    const locationScope = String(body?.locationScope || body?.locationType || '').trim().toLowerCase();
    const locationValue = String(body?.locationValue || '').trim();

    if (!customerName) throw new BadRequestException('name required');
    if (!phoneDigits) throw new BadRequestException('phone required');
    if (locationScope !== 'lima' && locationScope !== 'provincia') {
      throw new BadRequestException('invalid locationScope');
    }
    if (!locationValue) throw new BadRequestException('location required');

    const rows = await this.cartItems.find({ where: { cart_id: cartId }, order: { created_at: 'ASC' as any } });
    if (!rows.length) throw new BadRequestException('cart empty');

    const productIds = rows.map((it) => it.product_id);
    const products = await this.products.findBy({ id: In(productIds) });
    const productById = new Map(products.map((p) => [p.id, p] as const));
    const skus = products.map((p) => p.sku).filter(Boolean);
    const stagedBySku = skus.length ? await this.staged.findBy({ sku: In(skus) }) : [];
    const stagedBySkuMap = new Map(stagedBySku.map((s) => [s.sku, s] as const));

    const first = rows[0];
    const firstProduct = productById.get(first.product_id) || null;
    const firstStaged = firstProduct?.sku ? stagedBySkuMap.get(firstProduct.sku) || null : null;
    const productTitle = String(firstProduct?.title || firstStaged?.title || 'Producto').trim();
    const productColor = this.resolveRowColor(firstProduct, firstStaged) || null;
    const productPrice = this.resolveRowPrice(first, firstProduct, firstStaged);
    const requestType = this.resolveRequestType(first, firstProduct, firstStaged);

    const itemSummary = rows.map((row) => {
      const product = productById.get(row.product_id) || null;
      const staged = product?.sku ? stagedBySkuMap.get(product.sku) || null : null;
      return {
        productId: row.product_id,
        title: String(product?.title || staged?.title || 'Producto'),
        qty: Number(row.qty || 1),
        price: this.resolveRowPrice(row, product, staged),
      };
    });

    await this.ensureContactRequestsTable();
    const metadata = {
      items: itemSummary,
      source: 'cart',
      createdFrom: 'contact-modal',
    };
    const inserted = await this.cartItems.manager.query(
      `INSERT INTO contact_requests (
        cart_id,
        request_type,
        product_id,
        product_title,
        product_color,
        product_price,
        customer_name,
        customer_phone,
        location_scope,
        location_value,
        metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      RETURNING id`,
      [
        cartId,
        requestType,
        first.product_id || null,
        productTitle,
        productColor,
        Number(isFinite(productPrice) ? productPrice : 0).toFixed(2),
        customerName,
        phoneDigits,
        locationScope,
        locationValue,
        JSON.stringify(metadata),
      ],
    );

    return { ok: true, id: inserted?.[0]?.id || null };
  }
}
