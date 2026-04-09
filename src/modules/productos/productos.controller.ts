import { Body, Controller, Get, Headers, Post, UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Producto } from '../../entities/producto.entity';
import { CreateProductoDto } from '../../dtos/productos.dto';

@Controller('productos')
export class ProductosController {
  constructor(
    private auth: AuthService,
    @InjectRepository(Producto) private productosRepo: Repository<Producto>,
  ) {}

  private requireAuth(authHeader?: string) {
    const token = (authHeader || '').startsWith('Bearer ')
      ? (authHeader || '').substring(7)
      : undefined;
    if (!token) return null;
    try {
      return this.auth.verifyToken(token);
    } catch {
      return null;
    }
  }

  @Get()
  async list(@Headers('authorization') authHeader?: string) {
    const payload = this.requireAuth(authHeader);
    if (!payload) throw new UnauthorizedException();
    const items = await this.productosRepo.find({ order: { id: 'DESC' as any } });
    return items;
  }

  @Post()
  async create(@Headers('authorization') authHeader: string, @Body() body: CreateProductoDto) {
    const payload = this.requireAuth(authHeader);
    if (!payload) throw new UnauthorizedException();
    if (payload.role !== 'ADMIN') throw new ForbiddenException();
    const { tipo, estado, conCaja, casillero } = body || {};
    const item = await this.productosRepo.save(
      this.productosRepo.create({ tipo, estado, conCaja: !!conCaja, casillero: casillero || null })
    );
    return item;
  }
}
