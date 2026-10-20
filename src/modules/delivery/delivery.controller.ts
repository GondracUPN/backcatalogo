import { Body, Controller, Get, Headers, Param, Post, Put, Query } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { requireRole } from '../../utils/staff-auth';
import { DeliveryService } from './delivery.service';

@Controller()
export class DeliveryController {
  constructor(private delivery: DeliveryService, private auth: AuthService) {}

  // Público: opciones y puntos activos para el formulario de solicitud.
  @Get('site/delivery')
  async publicDelivery() {
    const [options, points] = await Promise.all([this.delivery.listOptions(true), this.delivery.listPoints(true)]);
    return {
      options: options.map((option) => ({
        id: option.id,
        code: option.code,
        name: option.name,
        kind: option.kind,
        description: option.description,
        cost: Number(option.cost),
        costNote: option.cost_note,
        schedule: option.schedule,
        conditions: option.conditions,
        requiresPoint: option.requires_point,
        requiresDistrict: option.requires_district,
        requiresAddress: option.requires_address,
      })),
      points: points.map((point) => ({ id: point.id, name: point.name, kind: point.kind, district: point.district })),
    };
  }

  @Get('admin/delivery/options')
  async options(@Headers('authorization') authHeader: string) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return { items: await this.delivery.listOptions() };
  }

  @Post('admin/delivery/options')
  async createOption(@Headers('authorization') authHeader: string, @Body() body: any) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return { ok: true, item: await this.delivery.saveOption(null, body) };
  }

  @Put('admin/delivery/options/:id')
  async updateOption(@Headers('authorization') authHeader: string, @Param('id') id: string, @Body() body: any) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return { ok: true, item: await this.delivery.saveOption(id, body) };
  }

  @Get('admin/delivery/points')
  async points(@Headers('authorization') authHeader: string) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return { items: await this.delivery.listPoints() };
  }

  @Post('admin/delivery/points')
  createPoint(@Headers('authorization') authHeader: string, @Body() body: any) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return this.delivery.savePoint(null, body);
  }

  @Put('admin/delivery/points/:id')
  updatePoint(@Headers('authorization') authHeader: string, @Param('id') id: string, @Body() body: any) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return this.delivery.savePoint(id, { ...body, force: true });
  }

  @Post('admin/delivery/points/:id/aliases')
  addAlias(@Headers('authorization') authHeader: string, @Param('id') id: string, @Body() body: any) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return this.delivery.addAlias(id, body?.alias);
  }

  @Get('admin/delivery/unmatched')
  async unmatched(@Headers('authorization') authHeader: string) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return { items: await this.delivery.unmatched() };
  }

  @Get('admin/delivery/stats')
  stats(@Headers('authorization') authHeader: string, @Query('from') from?: string, @Query('to') to?: string) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return this.delivery.stats(from, to);
  }
}
