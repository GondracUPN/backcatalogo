import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Headers, Param, Post, Put, Query, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CartItem } from '../../entities/cart-item.entity';
import { CatalogPublic } from '../../entities/catalog-public.entity';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { StagedProduct } from '../../entities/staged-product.entity';
import { CartAddDto, CartUpdateDto } from '../../dtos/cart.dto';
import { runOnce } from '../../utils/run-once';
import { publicProduct, publicStaged } from '../../utils/public-catalog';
import { applyReservedStock } from '../../utils/stock-reservations';
import { DeliveryService } from '../delivery/delivery.service';
import { PurchaseRequestsService } from '../purchase-requests/purchase-requests.service';

@Controller('cart')
export class CartController {
  constructor(
    @InjectRepository(CartItem) private cartItems: Repository<CartItem>,
    @InjectRepository(CatalogProduct) private products: Repository<CatalogProduct>,
    @InjectRepository(CatalogPublic) private publicCatalog: Repository<CatalogPublic>,
    @InjectRepository(StagedProduct) private staged: Repository<StagedProduct>,
    private delivery?: DeliveryService,
    private requests?: PurchaseRequestsService,
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
    if (!Number.isInteger(qty) || qty < 1) throw new BadRequestException('Cantidad no válida');
    if (product.status === 'sold') throw new BadRequestException('Este equipo ya se vendió');
    const stock = Number(product.stock ?? 0);
    if (!Number.isFinite(stock) || stock <= 0) throw new BadRequestException('Este equipo está agotado o reservado en este momento');
    const isNew = String(product.product_condition || '').toLowerCase().includes('nuevo');
    const maxQty = isNew ? stock : 1;
    if (qty > maxQty) throw new BadRequestException('No hay tantas unidades disponibles');
  }

  private ensureContactRequestsTable() {
    return runOnce('cart:contact_requests', async () => {
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
        owner_user_id integer NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await mgr.query(`ALTER TABLE contact_requests ADD COLUMN IF NOT EXISTS owner_user_id integer NULL`);
    });
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
    await applyReservedStock(this.products.manager, products);
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
        // Solo campos públicos: nunca el precio mínimo de oferta ni el costo de las notas.
        return {
          id: it.id,
          cart_id: it.cart_id,
          product_id: it.product_id,
          qty: it.qty,
          offer_price: it.offer_price ?? null,
          created_at: it.created_at,
          product: publicProduct(prod || null),
          staged: publicStaged(staged || null),
          slug: pub?.slug || null,
        };
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
    if (!product) throw new BadRequestException('Este equipo ya no está disponible');
    await applyReservedStock(this.products.manager, [product]);
    this.assertAvailableQuantity(product, qty);

    let offer: string | null = null;
    if (product.sale_type === 'OFERTA') {
      if (offerPrice === undefined || offerPrice === null) {
        throw new BadRequestException('offer required');
      }
      const offerNum = Number(offerPrice);
      const max = Number(product.price || 0);
      // Este endpoint no limita intentos: solo acepta el precio completo o una oferta
      // ya aceptada por /offers/submit. Así no sirve para descubrir el mínimo aceptado.
      const cents = (value: unknown) => Math.round(Number(value) * 100);
      const previous = await this.cartItems.findOne({ where: { cart_id: cartId, product_id: productId } });
      const previouslyAccepted = previous?.offer_price != null && cents(previous.offer_price) === cents(offerNum);
      if (!isFinite(offerNum) || (cents(offerNum) !== cents(max) && !previouslyAccepted)) {
        throw new BadRequestException('offer must be submitted through offers');
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
    if (!product) throw new BadRequestException('Este equipo ya no está disponible');
    await applyReservedStock(this.products.manager, [product]);
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

    const customerName = String(body?.name || body?.customerName || '').trim().slice(0, 120);
    const phoneDigits = String(body?.phone || body?.customerPhone || '').replace(/\D+/g, '');
    if (!customerName) throw new BadRequestException('Indica tu nombre');
    if (phoneDigits.length < 6 || phoneDigits.length > 15) throw new BadRequestException('Indica un número de WhatsApp válido');

    // Reintento o doble clic: devuelve las solicitudes ya creadas en lugar de fallar
    // con "carrito vacío" o duplicarlas.
    const rawKey = String(body?.submissionKey || '').trim();
    const submissionKey = /^[A-Za-z0-9-]{8,80}$/.test(rawKey) ? rawKey : null;
    const requestsReady = Boolean(this.requests && (await this.requests.isReady()));
    if (submissionKey && requestsReady) {
      const existing = await this.requests!.findBySubmission(submissionKey);
      if (existing.length) {
        return {
          ok: true,
          idempotent: true,
          id: existing[0].contact_request_id || null,
          ids: existing.map((row: any) => row.contact_request_id).filter(Boolean),
          numbers: existing.map((row: any) => row.number),
        };
      }
    }

    const notes = String(body?.notes || '').trim().slice(0, 500) || null;
    const district = String(body?.district || '').trim().slice(0, 80) || null;
    const address = String(body?.address || '').trim().slice(0, 200) || null;
    const pointText = String(body?.pointText || '').trim().slice(0, 120) || null;

    let locationScope: string;
    let resolvedLocationValue: string;
    let delivery: {
      optionId: string | null; optionName: string | null; kind: string | null; pointId: string | null;
      locationText: string | null; cost: number;
    };

    const optionId = String(body?.deliveryOptionId || '').trim();
    if (optionId && this.delivery) {
      const option = (await this.delivery.listOptions(true)).find((row) => row.id === optionId);
      if (!option) throw new BadRequestException('La opción de entrega elegida ya no está disponible');
      let point: { id: string; name: string } | null = null;
      const pointId = String(body?.deliveryPointId || '').trim();
      if (pointId) {
        point = (await this.delivery.listPoints(true)).find((row) => row.id === pointId) || null;
        if (!point) throw new BadRequestException('El punto de entrega elegido ya no está disponible');
      } else if (pointText) {
        point = await this.delivery.resolvePointForText(pointText);
      }
      if (option.requires_point && !point && !pointText) throw new BadRequestException('Elige un punto de entrega');
      if (option.requires_district && !district) throw new BadRequestException('Indica tu distrito');
      if (option.requires_address && !address) throw new BadRequestException('Indica la dirección de entrega');
      const isPickup = option.kind === 'pickup';
      const placeText = isPickup ? option.name : (point?.name || pointText || district || option.name);
      locationScope = isPickup ? 'almacen' : 'punto_medio';
      resolvedLocationValue = isPickup
        ? 'Recoger en almacen'
        : [option.name, point?.name || pointText, district, address].filter(Boolean).join(' · ');
      delivery = { optionId: option.id, optionName: option.name, kind: option.kind, pointId: point?.id || null, locationText: placeText, cost: Number(option.cost) || 0 };
    } else {
      // Formulario anterior (sin opciones configurables).
      locationScope = String(body?.locationScope || body?.locationType || '').trim().toLowerCase();
      const locationValue = String(body?.locationValue || '').trim();
      if (!['almacen', 'punto_medio', 'shalom'].includes(locationScope)) throw new BadRequestException('Elige una opción de entrega');
      if (locationScope !== 'almacen' && !locationValue) throw new BadRequestException('Indica el lugar de entrega');
      const isShalom = locationScope === 'shalom';
      resolvedLocationValue = locationScope === 'almacen' ? 'Recoger en almacen' : isShalom ? `Envío por Shalom · ${locationValue}` : locationValue;
      delivery = {
        optionId: null,
        optionName: locationScope === 'almacen' ? 'Recojo en almacén' : isShalom ? 'Envío por Shalom' : 'Entrega en punto medio',
        kind: locationScope === 'almacen' ? 'pickup' : isShalom ? 'province' : 'meeting_point',
        pointId: null,
        locationText: locationScope === 'almacen' ? 'Recojo en almacén' : locationValue,
        cost: 0,
      };
    }

    const rows = await this.cartItems.find({ where: { cart_id: cartId }, order: { created_at: 'ASC' as any } });
    if (!rows.length) throw new BadRequestException('Tu carrito está vacío');

    const productIds = rows.map((it) => it.product_id);
    const products = await this.products.findBy({ id: In(productIds) });
    const productById = new Map(products.map((p) => [p.id, p] as const));
    const skus = products.map((p) => p.sku).filter(Boolean);
    const stagedBySku = skus.length ? await this.staged.findBy({ sku: In(skus) }) : [];
    const stagedBySkuMap = new Map(stagedBySku.map((s) => [s.sku, s] as const));

    // Un carrito puede llevar días guardado: se vuelve a comprobar que cada
    // equipo siga publicado, sin vender y con unidades libres (stock - reservas).
    await applyReservedStock(this.products.manager, products);
    const published = await this.publicCatalog.findBy({ product_id: In(productIds), is_published: true as any });
    const publishedIds = new Set(published.map((row) => row.product_id));
    const unavailable: { productId: string; title: string; reason: string }[] = [];
    for (const row of rows) {
      const product = productById.get(row.product_id);
      const title = String(product?.title || 'Un producto').trim();
      const qty = Number(row.qty || 1);
      let reason = '';
      if (!product) reason = 'ya no existe';
      else if (product.status === 'sold') reason = 'ya se vendió';
      else if (!publishedIds.has(row.product_id)) reason = 'ya no está publicado';
      else {
        const stock = Number(product.stock ?? 0);
        const isNew = String(product.product_condition || '').toLowerCase().includes('nuevo');
        if (!Number.isFinite(stock) || stock <= 0) reason = 'está agotado o reservado';
        else if (qty > (isNew ? stock : 1)) reason = `solo quedan ${isNew ? stock : 1} disponibles`;
      }
      if (reason) unavailable.push({ productId: row.product_id, title, reason });
    }
    if (unavailable.length) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'CART_ITEMS_UNAVAILABLE',
        message: `Revisa tu carrito: ${unavailable.map((item) => `«${item.title}» ${item.reason}`).join('; ')}.`,
        unavailable,
      });
    }

    const itemSummary = rows.map((row) => {
      const product = productById.get(row.product_id) || null;
      const staged = product?.sku ? stagedBySkuMap.get(product.sku) || null : null;
      const price = this.resolveRowPrice(row, product, staged);
      return {
        productId: row.product_id,
        sku: product?.sku || staged?.sku || null,
        title: String(product?.title || staged?.title || 'Producto').trim(),
        color: this.resolveRowColor(product, staged) || null,
        qty: Number(row.qty || 1),
        price,
        lineTotal: price * Number(row.qty || 1),
        ownerUserId: staged?.owner_user_id ?? null,
      };
    });
    await this.ensureContactRequestsTable();
    const groups = new Map<string, typeof itemSummary>();
    for (const item of itemSummary) {
      const key = item.ownerUserId === null ? 'shared' : String(item.ownerUserId);
      groups.set(key, [...(groups.get(key) || []), item]);
    }

    const insertedIds: string[] = [];
    const numbers: string[] = [];
    // Todo o nada: registro anterior, solicitud nueva y vaciado del carrito.
    try {
    await this.cartItems.manager.transaction(async (mgr) => {
      for (const [ownerGroup, groupItems] of groups.entries()) {
        const firstItem = groupItems[0];
        const firstRow = rows.find((row) => row.product_id === firstItem.productId)!;
        const firstProduct = productById.get(firstRow.product_id) || null;
        const firstStaged = firstProduct?.sku ? stagedBySkuMap.get(firstProduct.sku) || null : null;
        const productTitle = groupItems
          .map((item) => `${item.qty > 1 ? `${item.qty} x ` : ''}${item.title}${item.color ? ` ${item.color}` : ''}`.trim())
          .join(' | ');
        const productColor = groupItems.length === 1 ? groupItems[0]?.color || null : null;
        const productPrice = groupItems.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);
        const requestType = this.resolveRequestType(firstRow, firstProduct, firstStaged);
        const metadata = { items: groupItems, source: 'cart', createdFrom: 'contact-modal', notes, deliveryOptionId: delivery.optionId };
        const inserted = await mgr.query(
          `INSERT INTO contact_requests (
          cart_id, request_type, product_id, product_title, product_color, product_price,
          customer_name, customer_phone, location_scope, location_value, metadata, owner_user_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
        RETURNING id`,
          [cartId, requestType, firstRow.product_id || null, productTitle, productColor,
            Number(isFinite(productPrice) ? productPrice : 0).toFixed(2), customerName, phoneDigits,
            locationScope, resolvedLocationValue, JSON.stringify(metadata), firstItem.ownerUserId],
        );
        const contactRequestId = inserted?.[0]?.id || null;
        if (contactRequestId) insertedIds.push(contactRequestId);
        if (requestsReady) {
          const request = await this.requests!.createInTransaction(mgr, {
            submissionKey,
            ownerGroup,
            ownerUserId: firstItem.ownerUserId,
            contactRequestId,
            customerName,
            customerPhone: phoneDigits,
            deliveryOptionId: delivery.optionId,
            deliveryOptionName: delivery.optionName,
            deliveryKind: delivery.kind,
            deliveryPointId: delivery.pointId,
            locationText: delivery.locationText,
            district,
            address,
            notes,
            deliveryCost: delivery.cost,
            items: groupItems.map((item) => ({ productId: item.productId, sku: item.sku, title: item.title, color: item.color, qty: item.qty, unitPrice: item.price })),
          });
          numbers.push(request.number);
        }
      }
      await mgr.delete(CartItem, { cart_id: cartId });
    });
    } catch (error: any) {
      // Dos envíos simultáneos con la misma clave: el segundo choca con el índice
      // único cuando el primero ya se guardó. Se responde con lo ya creado.
      if (error?.code === '23505' && submissionKey && requestsReady) {
        const existing = await this.requests!.findBySubmission(submissionKey);
        if (existing.length) {
          return {
            ok: true,
            idempotent: true,
            id: existing[0].contact_request_id || null,
            ids: existing.map((row: any) => row.contact_request_id).filter(Boolean),
            numbers: existing.map((row: any) => row.number),
          };
        }
      }
      throw error;
    }
    await this.refreshSessionCart(req, cartId);

    return { ok: true, id: insertedIds[0] || null, ids: insertedIds, numbers };
  }
}
