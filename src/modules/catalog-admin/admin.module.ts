import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StagedProduct } from '../../entities/staged-product.entity';
import { CatalogPublic } from '../../entities/catalog-public.entity';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { CatalogView } from '../../entities/catalog-view.entity';
import { AdminController } from './admin.controller';
import { AuthModule } from '../auth/auth.module';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([StagedProduct, CatalogPublic, CatalogProduct, CatalogView]), SyncModule],
  controllers: [AdminController],
})
export class AdminModule {}
