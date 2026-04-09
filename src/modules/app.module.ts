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
import { SyncModule } from './sync/sync.module';
import { AdminModule } from './catalog-admin/admin.module';
import { OrdersModule } from './orders/orders.module';
import { CatalogModule } from './catalog/catalog.module';
import { CartModule } from './cart/cart.module';
import * as dotenv from 'dotenv';

// Cargar variables de entorno antes de leer process.env en la configuración
dotenv.config();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [User, Producto, CatalogProduct, SyncLog, StagedProduct, CatalogPublic, Order, CartItem, OfferAttempt, CatalogView],
      synchronize: false,
      ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
    }),
    AuthModule,
    ProductosModule,
    SyncModule,
    AdminModule,
    OrdersModule,
    CatalogModule,
    CartModule,
  ],
})
export class AppModule {}
