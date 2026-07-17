import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Post, Put, UnauthorizedException, ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
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

  @Put('users/:id')
  async updateUser(@Headers('authorization') authHeader: string, @Param('id') idRaw: string, @Body() body: any) {
    const payload = this.requireRole(authHeader, ['ADMIN']);
    if (!payload) throw new ForbiddenException();
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('invalid user id');
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new BadRequestException('user not found');

    const username = String(body?.username ?? user.username).trim();
    const role = String(body?.role ?? user.role).trim().toUpperCase();
    const password = String(body?.password || '');
    if (username.length < 3) throw new BadRequestException('username must be at least 3 characters');
    if (!['ADMIN', 'VENDEDOR', 'CLIENTE'].includes(role)) throw new BadRequestException('invalid role');
    if (password && password.length < 6) throw new BadRequestException('password must be at least 6 characters');
    const duplicate = await this.usersRepo.findOne({ where: { username } });
    if (duplicate && duplicate.id !== id) throw new ConflictException('username already exists');
    if (Number(payload.sub) === id && role !== 'ADMIN') throw new BadRequestException('you cannot remove your own admin role');

    user.username = username;
    user.role = role as any;
    if (password) user.passwordHash = await bcrypt.hash(password, 10);
    const saved = await this.usersRepo.save(user);
    return { id: saved.id, username: saved.username, role: String(saved.role).toLowerCase() };
  }

  @Delete('users/:id')
  async deleteUser(@Headers('authorization') authHeader: string, @Param('id') idRaw: string) {
    const payload = this.requireRole(authHeader, ['ADMIN']);
    if (!payload) throw new ForbiddenException();
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('invalid user id');
    if (Number(payload.sub) === id) throw new BadRequestException('you cannot delete your own user');
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new BadRequestException('user not found');
    await this.usersRepo.delete({ id });
    return { ok: true };
  }

  private requireRole(authHeader: string | undefined, roles: string[]) {
    const token = (authHeader || '').startsWith('Bearer ')
      ? (authHeader || '').substring(7)
      : undefined;
    if (!token) return null;
    try {
      const payload = this.auth.verifyToken(token);
      if (!roles.includes(String(payload.role || '').toUpperCase())) return null;
      return payload;
    } catch {
      return null;
    }
  }
}
