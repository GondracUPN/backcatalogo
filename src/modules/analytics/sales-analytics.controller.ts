import { Controller, Get, Headers, Query } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { requireRole } from '../../utils/staff-auth';
import { scopeForStaff } from '../../utils/sales-scope';
import { parseRange } from './analytics.service';
import { SalesAnalyticsService } from './sales-analytics.service';

@Controller('admin/analytics')
export class SalesAnalyticsController {
  constructor(
    private readonly auth: AuthService,
    private readonly sales: SalesAnalyticsService,
  ) {}

  private context(
    authorization: string,
    from?: string,
    to?: string,
    owner?: string,
    group?: string,
  ) {
    const staff = requireRole(this.auth, authorization, ['ADMIN', 'VENDEDOR']);
    return {
      scope: scopeForStaff(staff, owner),
      range: parseRange(from, to, group || 'month'),
    };
  }

  @Get('sales/summary')
  summary(
    @Headers('authorization') auth: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('owner') owner?: string,
  ) {
    const { range, scope } = this.context(auth, from, to, owner);
    return this.sales.summary(range, scope);
  }

  @Get('sales/timeline')
  timeline(
    @Headers('authorization') auth: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('owner') owner?: string,
    @Query('group') group?: string,
  ) {
    const { range, scope } = this.context(auth, from, to, owner, group);
    return this.sales.timeline(range, scope);
  }

  @Get('sales/products')
  products(
    @Headers('authorization') auth: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('owner') owner?: string,
  ) {
    const { range, scope } = this.context(auth, from, to, owner);
    return this.sales.products(range, scope);
  }

  @Get('sales/channels')
  channels(
    @Headers('authorization') auth: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('owner') owner?: string,
  ) {
    const { range, scope } = this.context(auth, from, to, owner);
    return this.sales.channels(range, scope);
  }

  @Get('sales/stock')
  stock(
    @Headers('authorization') auth: string,
    @Query('owner') owner?: string,
  ) {
    return this.sales.stock(
      scopeForStaff(requireRole(this.auth, auth, ['ADMIN', 'VENDEDOR']), owner),
    );
  }

  @Get('sellers')
  sellers(
    @Headers('authorization') auth: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    requireRole(this.auth, auth, ['ADMIN']);
    return this.sales.sellers(parseRange(from, to, 'month'));
  }
}
