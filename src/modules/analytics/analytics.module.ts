import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { SalesAnalyticsService } from './sales-analytics.service';
import { SalesAnalyticsController } from './sales-analytics.controller';

@Module({
  imports: [AuthModule],
  controllers: [AnalyticsController, SalesAnalyticsController],
  providers: [AnalyticsService, SalesAnalyticsService],
})
export class AnalyticsModule {}
