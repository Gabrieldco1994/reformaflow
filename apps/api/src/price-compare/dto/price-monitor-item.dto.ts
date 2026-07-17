import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsNumber,
  MaxLength,
  Min,
  Max,
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
  @IsUrl()
  @MaxLength(1200)
  url?: string;

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
  @IsNumber()
  targetPrice?: number; // in reais for new alert API

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  diasMonitoramento?: number; // default 30

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
  @IsUrl()
  @MaxLength(1200)
  url?: string;

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
  @IsNumber()
  targetPrice?: number;

  @IsOptional()
  monitoringEndDate?: Date;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export interface PriceMonitorItemResponseDto {
  id: string;
  title: string;
  url?: string;
  query?: string;
  notes?: string;
  targetPrice: number | null;
  monitoringEndDate: string | null; // ISO format
  alertSent: boolean;
  ativo: boolean; // computed
  lastCheckedAt: string | null;
  lastBestPrice: number | null;
  lastBestStore: string | null;
  lastBestLink: string | null;
  createdAt: string;
  updatedAt: string;
}
