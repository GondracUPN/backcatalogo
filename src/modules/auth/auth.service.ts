import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { JwtPayload } from 'jsonwebtoken';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/user.entity';
import { consumeLoginAttempt, loginBucket } from '../../utils/login-attempts';

@Injectable()
export class AuthService {
  constructor(@InjectRepository(User) private usersRepo: Repository<User>) {}

  private jwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret || !String(secret).trim()) {
      throw new UnauthorizedException('JWT secret is not configured');
    }
    return String(secret);
  }

  async validateUser(username: string, password: string, ip = 'unknown') {
    await consumeLoginAttempt(this.usersRepo.manager, username, ip);
    const user = await this.usersRepo.findOne({ where: { username } });
    // También compara para cuentas inexistentes, con el mismo coste de bcrypt.
    const valid = await bcrypt.compare(password, user?.passwordHash || '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy');
    if (!user || !valid) {
      console.warn('[auth] Invalid credentials');
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.usersRepo.manager.query(`DELETE FROM auth_login_attempts WHERE key = $1`, [loginBucket('account', username.toLowerCase())]);
    await this.usersRepo.manager.query(`UPDATE auth_login_attempts SET attempts = GREATEST(attempts - 1, 0) WHERE key = $1`, [loginBucket('ip', ip)]);
    return user;
  }

  signToken(payload: { sub: number; username: string; role: string; canViewServiceInventory?: boolean }) {
    return jwt.sign(payload, this.jwtSecret(), { expiresIn: '7d' });
  }

  verifyToken(token: string) {
    const payload = jwt.verify(token, this.jwtSecret());
    if (typeof payload === 'string') throw new UnauthorizedException('Invalid token');
    const typed = payload as JwtPayload & { sub?: number | string; username?: string; role?: string; canViewServiceInventory?: boolean };
    if (typed.sub === undefined || !typed.username || !typed.role) {
      throw new UnauthorizedException('Invalid token payload');
    }
    return {
      sub: Number(typed.sub),
      username: String(typed.username),
      role: String(typed.role),
      canViewServiceInventory: Boolean(typed.canViewServiceInventory),
    };
  }
}
