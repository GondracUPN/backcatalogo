import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { databaseUrl } from './utils/database-url';
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
import { SiteTheme } from './entities/site-theme.entity';

dotenv.config();
const url = databaseUrl();

// Exportar una única instancia (default) como requiere el CLI de TypeORM
export default new DataSource({
  type: 'postgres',
  url,
  entities: [User, Producto, CatalogProduct, SyncLog, StagedProduct, CatalogPublic, Order, CartItem, OfferAttempt, CatalogView, SiteTheme],
  migrations: ['src/migrations/*.ts'],
  ssl: url.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
});
