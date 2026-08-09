import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { AuthModule } from '../auth/auth.module';
import { MarketplaceBridgeController } from './marketplace-bridge.controller';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([CatalogProduct])],
  controllers: [MarketplaceBridgeController],
})
export class MarketplaceBridgeModule {}
