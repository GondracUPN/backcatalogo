import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ProductosModule } from './productos/productos.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../entities/user.entity';
import { Producto } from '../entities/producto.entity';
import { CatalogProduct } from '../entities/catalog-product.entity';
import { SyncLog } from '../entities/sync-log.entity';
import { StagedProduct } from '../entities/staged-product.entity';
import { CatalogPublic } from '../entities/catalog-public.entity';
import { Order } from '../entities/order.entity';
import { CartItem } from '../entities/cart-item.entity';
import { OfferAttempt } from '../entities/offer-attempt.entity';
import { CatalogView } from '../entities/catalog-view.entity';
import { SiteTheme } from '../entities/site-theme.entity';
import { SyncModule } from './sync/sync.module';
import { AdminModule } from './catalog-admin/admin.module';
import { OrdersModule } from './orders/orders.module';
import { CatalogModule } from './catalog/catalog.module';
import { CartModule } from './cart/cart.module';
import { MarketplaceBridgeModule } from './marketplace-bridge/marketplace-bridge.module';
import { ThemesModule } from './themes/themes.module';
import { DeliveryModule } from './delivery/delivery.module';
import { PurchaseRequestsModule } from './purchase-requests/purchase-requests.module';
import { AnalyticsModule } from './analytics/analytics.module';
import * as dotenv from 'dotenv';
import { databaseUrl } from '../utils/database-url';

// Cargar variables de entorno antes de leer process.env en la configuración
dotenv.config();
const url = databaseUrl();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url,
      entities: [User, Producto, CatalogProduct, SyncLog, StagedProduct, CatalogPublic, Order, CartItem, OfferAttempt, CatalogView, SiteTheme],
      synchronize: false,
      ssl: url.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
    }),
    AuthModule,
    ProductosModule,
    SyncModule,
    AdminModule,
    OrdersModule,
    CatalogModule,
    CartModule,
    MarketplaceBridgeModule,
    ThemesModule,
    DeliveryModule,
    PurchaseRequestsModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
