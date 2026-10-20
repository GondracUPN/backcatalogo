import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { requireRole } from '../../utils/staff-auth';
import { ProductPhotosService } from './product-photos.service';
import { requireSyncSecret } from '../../utils/shared-secret';

@Controller('admin')
export class ProductPhotosController {
  constructor(
    private auth: AuthService,
    private photos: ProductPhotosService,
  ) {}
  @Get('public/:productId/photos/access')
  async access(
    @Headers('authorization') authorization: string,
    @Param('productId') productId: string,
    @Query('url') url: string,
  ) {
    const staff = requireRole(this.auth, authorization, ['ADMIN', 'VENDEDOR']);
    return this.photos.access(productId, url, staff);
  }
  @Post('public/:productId/photos/replace')
  replace(
    @Headers('authorization') authorization: string,
    @Param('productId') productId: string,
    @Body()
    body: { url_old: string; url_new: string },
    @Headers('x-sync-secret') secret: string,
  ) {
    const staff = requireRole(this.auth, authorization, ['ADMIN', 'VENDEDOR']);
    requireSyncSecret({ secret });
    return this.photos.replace(productId, body.url_old, body.url_new, staff);
  }
  @Post('photos/discard')
  discard(
    @Headers('authorization') authorization: string,
    @Body()
    body: { url: string },
    @Headers('x-sync-secret') secret: string,
  ) {
    const staff = requireRole(this.auth, authorization, ['ADMIN', 'VENDEDOR']);
    requireSyncSecret({ secret });
    return this.photos.discard(body.url, String(staff.sub));
  }
  @Post('public/:productId/photos/reserve')
  reserve(
    @Headers('authorization') authorization: string,
    @Param('productId') productId: string,
    @Body()
    body: { url_old: string; url_new: string },
    @Headers('x-sync-secret') secret: string,
  ) {
    const staff = requireRole(this.auth, authorization, ['ADMIN', 'VENDEDOR']);
    requireSyncSecret({ secret });
    return this.photos.reserve(productId, body.url_old, body.url_new, staff);
  }
  @Post('public/:productId/photos/cleanup')
  cleanup(
    @Headers('authorization') authorization: string,
    @Param('productId') productId: string,
  ) {
    const staff = requireRole(this.auth, authorization, ['ADMIN']);
    return this.photos.cleanup(productId, true, String(staff.sub));
  }
  @Get('public/:productId/photos/plan')
  plan(
    @Headers('authorization') authorization: string,
    @Param('productId') productId: string,
  ) {
    return this.photos.plan(
      productId,
      requireRole(this.auth, authorization, ['ADMIN']),
    );
  }
  @Post('public/:productId/photos/hold')
  hold(
    @Headers('authorization') authorization: string,
    @Param('productId') productId: string,
    @Body()
    body: { hold: boolean; reason?: string },
  ) {
    const staff = requireRole(this.auth, authorization, ['ADMIN']);
    return this.photos.hold(
      productId,
      body.hold,
      String(body.reason || ''),
      staff,
    );
  }
}
