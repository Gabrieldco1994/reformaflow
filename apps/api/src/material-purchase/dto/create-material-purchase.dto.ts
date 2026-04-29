import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsEnum,
  Min,
  IsInt,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

enum PaymentMethodDto {
  CASH = 'CASH',
  PIX = 'PIX',
  BANK_TRANSFER = 'BANK_TRANSFER',
  CREDIT_CARD = 'CREDIT_CARD',
  DEBIT_CARD = 'DEBIT_CARD',
  BOLETO = 'BOLETO',
}

export class CreateMaterialPurchaseDto {
  @ApiProperty({ example: '2026-05-10' })
  @IsDateString()
  date!: string;

  @ApiProperty({ example: 'Porcelanato 60x60 Portinari' })
  @IsString()
  item!: string;

  @ApiProperty({ example: 'room-id-123' })
  @IsString()
  roomId!: string;

  @ApiProperty({ example: 'work-type-id-456' })
  @IsString()
  workTypeId!: string;

  @ApiPropertyOptional({ example: 'Leroy Merlin' })
  @IsOptional()
  @IsString()
  store?: string;

  @ApiProperty({ enum: PaymentMethodDto, example: 'PIX' })
  @IsEnum(PaymentMethodDto)
  paymentMethod!: string;

  @ApiProperty({ example: 2500.0 })
  @IsNumber()
  @Min(0.01)
  totalAmount!: number;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  installments?: number;

  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @IsInt()
  warrantyMonths?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  hasInvoice?: boolean;

  @ApiPropertyOptional({ example: 'Entrega em 15 dias' })
  @IsOptional()
  @IsString()
  notes?: string;
}
