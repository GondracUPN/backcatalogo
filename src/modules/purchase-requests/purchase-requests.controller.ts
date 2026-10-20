import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { requireRole } from '../../utils/staff-auth';
import { PurchaseRequestsService } from './purchase-requests.service';

@Controller('admin/purchase-requests')
export class PurchaseRequestsController {
  constructor(private requests: PurchaseRequestsService, private auth: AuthService) {}

  // ADMIN ve las de Macsomenos; cada vendedor independiente, solo las suyas.
  @Get()
  list(
    @Headers('authorization') authHeader: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const staff = requireRole(this.auth, authHeader, ['ADMIN', 'VENDEDOR']);
    return this.requests.list(staff, { status, q, page, pageSize });
  }

  @Get(':id')
  detail(@Headers('authorization') authHeader: string, @Param('id') id: string) {
    const staff = requireRole(this.auth, authHeader, ['ADMIN', 'VENDEDOR']);
    return this.requests.detail(staff, id);
  }

  @Post(':id/status')
  changeStatus(@Headers('authorization') authHeader: string, @Param('id') id: string, @Body() body: any) {
    const staff = requireRole(this.auth, authHeader, ['ADMIN', 'VENDEDOR']);
    return this.requests.changeStatus(staff, id, body);
  }
}
