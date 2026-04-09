import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogProduct } from '../../entities/catalog-product.entity';
import { SyncLog } from '../../entities/sync-log.entity';
import { StagedProduct } from '../../entities/staged-product.entity';
import { SyncController } from './sync.controller';
import { PullSyncService } from './pull.service';

@Module({
  imports: [TypeOrmModule.forFeature([CatalogProduct, SyncLog, StagedProduct])],
  controllers: [SyncController],
  providers: [PullSyncService],
  exports: [PullSyncService],
})
export class SyncModule {}
