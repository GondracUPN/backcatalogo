import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SiteTheme } from '../../entities/site-theme.entity';
import { AuthModule } from '../auth/auth.module';
import { ThemesController } from './themes.controller';
import { ThemesService } from './themes.service';

@Module({
  imports: [TypeOrmModule.forFeature([SiteTheme]), AuthModule],
  controllers: [ThemesController],
  providers: [ThemesService],
})
export class ThemesModule {}
