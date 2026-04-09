import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { Order } from '../../entities/order.entity';
import { OrdersController } from './orders.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([CatalogProduct, Order])],
  controllers: [OrdersController],
})
export class OrdersModule {}

