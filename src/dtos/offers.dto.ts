import { Transform } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';

export class OfferSubmitDto {
  @IsUUID()
  @IsNotEmpty()
  productId!: string;

  @IsNumber()
  @Transform(({ value }) => Number(value))
  offer!: number;

  @IsOptional()
  @IsUUID()
  cartId?: string;

  @IsOptional()
  @IsString()
  fingerprint?: string;
}
