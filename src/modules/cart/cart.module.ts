import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CartItem } from '../../entities/cart-item.entity';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { CatalogPublic } from '../../entities/catalog-public.entity';
import { StagedProduct } from '../../entities/staged-product.entity';
import { CartController } from './cart.controller';
import { OfferAttempt } from '../../entities/offer-attempt.entity';
import { OffersController } from './offers.controller';
import { DeliveryModule } from '../delivery/delivery.module';
import { PurchaseRequestsModule } from '../purchase-requests/purchase-requests.module';

@Module({
  imports: [TypeOrmModule.forFeature([CartItem, CatalogProduct, CatalogPublic, StagedProduct, OfferAttempt]), DeliveryModule, PurchaseRequestsModule],
  controllers: [CartController, OffersController],
})
export class CartModule {}
