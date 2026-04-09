import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { JwtPayload } from 'jsonwebtoken';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/user.entity';

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

  async validateUser(username: string, password: string) {
    const user = await this.usersRepo.findOne({ where: { username } });
    if (!user) throw new UnauthorizedException('Invalid credentials');
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    return user;
  }

  signToken(payload: { sub: number; username: string; role: string }) {
    return jwt.sign(payload, this.jwtSecret(), { expiresIn: '7d' });
  }

  verifyToken(token: string) {
    const payload = jwt.verify(token, this.jwtSecret());
    if (typeof payload === 'string') throw new UnauthorizedException('Invalid token');
    const typed = payload as JwtPayload & { sub?: number | string; username?: string; role?: string };
    if (typed.sub === undefined || !typed.username || !typed.role) {
      throw new UnauthorizedException('Invalid token payload');
    }
    return {
      sub: Number(typed.sub),
      username: String(typed.username),
      role: String(typed.role),
    };
  }
}
