import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsUUID, Min } from 'class-validator';

export class CartAddDto {
  @IsUUID()
  @IsNotEmpty()
  productId!: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  qty?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsNumber()
  offerPrice?: number;

  @IsOptional()
  @IsUUID()
  cartId?: string;
}

export class CartUpdateDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  qty?: number;

  @IsOptional()
  @IsUUID()
  cartId?: string;
}
