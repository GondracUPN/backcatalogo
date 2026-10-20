import { Body, Controller, Get, Headers, Param, Post, Put, Query } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { requireRole } from '../../utils/staff-auth';
import { ThemesService, toPublicTheme } from './themes.service';
import { themePresets } from './theme-presets';

@Controller()
export class ThemesController {
  constructor(private themes: ThemesService, private auth: AuthService) {}

  // Público: temática vigente según fecha y prioridad (hora de Lima).
  @Get('site/theme')
  async active() {
    return { theme: await this.themes.active() };
  }

  // Público: vista previa de una temática concreta (no contiene datos privados).
  @Get('site/theme/:id')
  async preview(@Param('id') id: string) {
    return { theme: toPublicTheme(await this.themes.byId(id)) };
  }

  @Get('admin/themes')
  async list(@Headers('authorization') authHeader: string) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    const [items, active] = await Promise.all([this.themes.list(), this.themes.active()]);
    return { items, activeId: active?.id || null };
  }

  @Get('admin/themes/presets')
  presets(@Headers('authorization') authHeader: string, @Query('year') yearRaw?: string) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    const year = Number(yearRaw) || new Date().getFullYear();
    return { year, items: themePresets(year) };
  }

  @Post('admin/themes')
  async create(@Headers('authorization') authHeader: string, @Body() body: any) {
    const staff = requireRole(this.auth, authHeader, ['ADMIN']);
    return { ok: true, item: await this.themes.create(body, staff.username) };
  }

  @Put('admin/themes/:id')
  async update(@Headers('authorization') authHeader: string, @Param('id') id: string, @Body() body: any) {
    const staff = requireRole(this.auth, authHeader, ['ADMIN']);
    return { ok: true, item: await this.themes.update(id, body, staff.username) };
  }

  @Post('admin/themes/:id/delete')
  async remove(@Headers('authorization') authHeader: string, @Param('id') id: string) {
    requireRole(this.auth, authHeader, ['ADMIN']);
    return this.themes.remove(id);
  }
}
