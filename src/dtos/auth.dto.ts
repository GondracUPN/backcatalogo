import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(3)
  username!: string;

  @IsString()
  @MinLength(4)
  password!: string;
}

export class RegisterDto {
  @IsString()
  @MinLength(3)
  username!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : String(value).toUpperCase()))
  @IsIn(['ADMIN', 'VENDEDOR', 'CLIENTE'], { message: 'invalid role' })
  role?: string;
}

