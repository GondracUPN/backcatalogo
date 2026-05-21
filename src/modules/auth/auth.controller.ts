import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, UnauthorizedException, ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from '../../dtos/auth.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/user.entity';
import * as bcrypt from 'bcryptjs';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, @InjectRepository(User) private usersRepo: Repository<User>) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto) {
    const { username, password } = body || {};
    // eslint-disable-next-line no-console
    console.log(`[Auth] login attempt for user: ${username}`);
    const user = await this.auth.validateUser(username, password);
    const token = this.auth.signToken({ sub: user.id, username: user.username, role: user.role });
    // Frontend espera roles en minúsculas ("admin", "vendedor", "cliente")
    const roleLc = String(user.role || '').toLowerCase();
    return { access_token: token, user: { id: user.id, username: user.username, role: roleLc } };
  }

  @Get('me')
  async me(@Headers('authorization') authHeader?: string) {
    const token = (authHeader || '').startsWith('Bearer ')
      ? (authHeader || '').substring(7)
      : undefined;
    if (!token) throw new UnauthorizedException();
    try {
      const payload = this.auth.verifyToken(token);
      return { ...payload, role: String(payload.role || '').toLowerCase() } as any;
    } catch {
      throw new UnauthorizedException();
    }
  }

  @Get('users')
  async listUsers(@Headers('authorization') authHeader?: string) {
    const payload = this.requireRole(authHeader, ['ADMIN']);
    if (!payload) throw new ForbiddenException();
    const users = await this.usersRepo.find({ select: { id: true, username: true, role: true } as any });
    // Opcional: normalizar rol a minúsculas para UI
    return users.map(u => ({ ...u, role: String(u.role).toLowerCase() }));
  }

  @Post('register')
  async register(@Headers('authorization') authHeader: string, @Body() body: RegisterDto) {
    const payload = this.requireRole(authHeader, ['ADMIN']);
    if (!payload) throw new ForbiddenException();
    const { username, password } = body || {};
    const roleUp = String((body as any)?.role || 'CLIENTE').trim().toUpperCase();
    if (!username || !String(username).trim()) throw new BadRequestException('username required');
    if (!password || String(password).length < 6) throw new BadRequestException('password must be at least 6 characters');
    if (!['ADMIN', 'VENDEDOR', 'CLIENTE'].includes(roleUp)) throw new BadRequestException('invalid role');
    const exists = await this.usersRepo.findOne({ where: { username } });
    if (exists) throw new ConflictException('username already exists');
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await this.usersRepo.save(this.usersRepo.create({ username, passwordHash, role: roleUp as any }));
    return { id: user.id, username: user.username, role: String(user.role).toLowerCase() };
  }

  private requireRole(authHeader: string | undefined, roles: string[]) {
    const token = (authHeader || '').startsWith('Bearer ')
      ? (authHeader || '').substring(7)
      : undefined;
    if (!token) return null;
    try {
      const payload = this.auth.verifyToken(token);
      if (!roles.includes(payload.role)) return null;
      return payload;
    } catch {
      return null;
    }
  }
}
