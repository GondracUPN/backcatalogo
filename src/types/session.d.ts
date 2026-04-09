import 'express-session';

declare module 'express-session' {
  interface SessionData {
    cartId?: string;
    cartItems?: Array<{ id: string; product_id: string; qty: number; offer_price?: string | null }>;
  }
}
