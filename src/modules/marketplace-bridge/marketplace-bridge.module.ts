import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { AuthModule } from '../auth/auth.module';
import { MarketplaceBridgeController } from './marketplace-bridge.controller';
import { MarketplaceResolverController } from './marketplace-resolver.controller';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([CatalogProduct])],
  controllers: [MarketplaceBridgeController, MarketplaceResolverController],
})
export class MarketplaceBridgeModule {}
