import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { User } from './entities/user.entity';
import { Producto } from './entities/producto.entity';
import { CatalogProduct } from './entities/catalog-product.entity';
import { SyncLog } from './entities/sync-log.entity';
import { StagedProduct } from './entities/staged-product.entity';
import { CatalogPublic } from './entities/catalog-public.entity';
import { Order } from './entities/order.entity';
import { CartItem } from './entities/cart-item.entity';
import { OfferAttempt } from './entities/offer-attempt.entity';
import { CatalogView } from './entities/catalog-view.entity';

dotenv.config();

// Exportar una única instancia (default) como requiere el CLI de TypeORM
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [User, Producto, CatalogProduct, SyncLog, StagedProduct, CatalogPublic, Order, CartItem, OfferAttempt, CatalogView],
  migrations: ['src/migrations/*.ts'],
  ssl: process.env.DATABASE_URL?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
});
