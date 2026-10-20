import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StagedProduct } from '../../entities/staged-product.entity';
import { CatalogPublic } from '../../entities/catalog-public.entity';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { CatalogView } from '../../entities/catalog-view.entity';
import { AdminController } from './admin.controller';
import { AuthModule } from '../auth/auth.module';
import { SyncModule } from '../sync/sync.module';
import { SalesSyncService } from './sales-sync.service';
import { PurchaseRequestsModule } from '../purchase-requests/purchase-requests.module';
import { ProductPhotosController } from './product-photos.controller';
import { ProductPhotosService } from './product-photos.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([StagedProduct, CatalogPublic, CatalogProduct, CatalogView]), SyncModule, PurchaseRequestsModule],
  controllers: [AdminController, ProductPhotosController],
  providers: [SalesSyncService, ProductPhotosService],
})
export class AdminModule {}
