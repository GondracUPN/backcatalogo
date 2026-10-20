import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { requireRole } from '../../utils/staff-auth';
import { AnalyticsService, parseRange } from './analytics.service';
import { cleanEvent } from './event-ingest';

const MAX_EVENTS = 25;

@Controller()
export class AnalyticsController {
  constructor(private analytics: AnalyticsService, private auth: AuthService) {}

  /**
   * Público: recibe eventos de navegación en lote. Sin consentimiento analítico
   * los identificadores se descartan y el evento solo suma a los totales.
   */
  @Post('site/events')
  @HttpCode(204)
  async ingest(@Body() body: any) {
    const raw = Array.isArray(body?.events) ? body.events : [];
    if (raw.length > MAX_EVENTS) throw new BadRequestException(`Máximo ${MAX_EVENTS} eventos por envío`);
    const context = {
      consent: body?.consent === true,
      sessionId: body?.sessionId,
      visitorId: body?.visitorId,
      ownHost: String(process.env.SITE_HOST || 'macsomenos.com').toLowerCase(),
    };
    const events = raw.map((event: any) => cleanEvent(event, context)).filter(Boolean);
    await this.analytics.insert(events as any);
  }

  @Get('admin/analytics/overview')
  overview(@Headers('authorization') authHeader: string, @Query('from') from?: string, @Query('to') to?: string, @Query('group') group?: string) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return this.analytics.overview(parseRange(from, to, group));
  }

  @Get('admin/analytics/products')
  products(@Headers('authorization') authHeader: string, @Query('from') from?: string, @Query('to') to?: string) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return this.analytics.products(parseRange(from, to, 'month'));
  }

  @Get('admin/analytics/searches')
  searches(@Headers('authorization') authHeader: string, @Query('from') from?: string, @Query('to') to?: string) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return this.analytics.searches(parseRange(from, to, 'month'));
  }

  @Get('admin/analytics/funnel')
  funnel(@Headers('authorization') authHeader: string, @Query('from') from?: string, @Query('to') to?: string) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return this.analytics.funnel(parseRange(from, to, 'month'));
  }

  @Get('admin/analytics/sources')
  sources(@Headers('authorization') authHeader: string, @Query('from') from?: string, @Query('to') to?: string) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return this.analytics.sources(parseRange(from, to, 'month'));
  }
}
