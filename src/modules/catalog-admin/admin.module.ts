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

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([StagedProduct, CatalogPublic, CatalogProduct, CatalogView]), SyncModule, PurchaseRequestsModule],
  controllers: [AdminController],
  providers: [SalesSyncService],
})
export class AdminModule {}
