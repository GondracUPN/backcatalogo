import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogPublic } from '../../entities/catalog-public.entity';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { CatalogController } from './catalog.controller';
import { StagedProduct } from '../../entities/staged-product.entity';
import { CatalogView } from '../../entities/catalog-view.entity';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [TypeOrmModule.forFeature([CatalogPublic, CatalogProduct, StagedProduct, CatalogView]), SyncModule],
  controllers: [CatalogController],
})
export class CatalogModule {}
