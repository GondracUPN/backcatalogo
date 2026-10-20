import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { requireRole } from '../../utils/staff-auth';
import { ProductPhotosService } from './product-photos.service';
import { requireSyncSecret } from '../../utils/shared-secret';

@Controller('admin')
export class ProductPhotosController {
  constructor(private auth: AuthService, private photos: ProductPhotosService) {}
  @Get('public/:productId/photos/access')
  async access(@Headers('authorization') h: string, @Param('productId') id: string, @Query('url') url: string) {
    const staff = requireRole(this.auth,h,['ADMIN','VENDEDOR']);
    return this.photos.access(id,url,staff);
  }
  @Post('public/:productId/photos/replace')
  replace(@Headers('authorization') h: string, @Param('productId') id: string, @Body() b: any, @Headers('x-sync-secret') secret: string) {
    const staff = requireRole(this.auth,h,['ADMIN','VENDEDOR']);
    requireSyncSecret({secret});
    return this.photos.replace(id,b.url_old,b.url_new,staff);
  }
  @Post('photos/discard')
  discard(@Headers('authorization') h: string, @Body() b: any, @Headers('x-sync-secret') secret: string) {
    const staff = requireRole(this.auth,h,['ADMIN','VENDEDOR']);
    requireSyncSecret({secret});
    return this.photos.discard(b.url,String(staff.sub));
  }
  @Post('public/:productId/photos/reserve')
  reserve(@Headers('authorization') h: string, @Param('productId') id: string, @Body() b: any, @Headers('x-sync-secret') secret: string) {
    const staff = requireRole(this.auth,h,['ADMIN','VENDEDOR']);
    requireSyncSecret({secret});
    return this.photos.reserve(id,b.url_old,b.url_new,staff);
  }
  @Post('public/:productId/photos/cleanup')
  cleanup(@Headers('authorization') h: string, @Param('productId') id: string) {
    const staff = requireRole(this.auth,h,['ADMIN']);
    return this.photos.cleanup(id,true,String(staff.sub));
  }
  @Get('public/:productId/photos/plan')
  plan(@Headers('authorization') h: string, @Param('productId') id: string) {
    return this.photos.plan(id,requireRole(this.auth,h,['ADMIN']));
  }
  @Post('public/:productId/photos/hold')
  hold(@Headers('authorization') h: string, @Param('productId') id: string, @Body() b: any) {
    const staff = requireRole(this.auth,h,['ADMIN']);
    return this.photos.hold(id,b.hold,String(b.reason || ''),staff);
  }
}
