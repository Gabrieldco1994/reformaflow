import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreatePriceMonitorItemDto {
  @IsString()
  @MinLength(2)
  @MaxLength(140)
  title!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(140)
  query?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(1200)
  productUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  notes?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  referencePriceCents?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  targetPriceCents?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePriceMonitorItemDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(140)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(140)
  query?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(1200)
  productUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  notes?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  referencePriceCents?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  targetPriceCents?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
