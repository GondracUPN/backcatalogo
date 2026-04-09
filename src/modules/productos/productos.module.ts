import { Module } from '@nestjs/common';
import { ProductosController } from './productos.controller';
import { AuthService } from '../auth/auth.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Producto } from '../../entities/producto.entity';
import { User } from '../../entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Producto, User])],
  controllers: [ProductosController],
  providers: [AuthService],
})
export class ProductosModule {}
