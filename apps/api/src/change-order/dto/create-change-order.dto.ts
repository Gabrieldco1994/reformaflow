import { IsString, IsNumber, IsOptional, IsDateString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateChangeOrderDto {
  @ApiProperty({ example: '2026-06-01' })
  @IsDateString()
  date!: string;

  @ApiProperty({ example: 'Adicionar ponto elétrico na cozinha' })
  @IsString()
  item!: string;

  @ApiProperty({ example: 'Cliente solicitou tomada extra para cooktop' })
  @IsString()
  reason!: string;

  @ApiPropertyOptional({ example: 'room-id-cozinha' })
  @IsOptional()
  @IsString()
  roomId?: string;

  @ApiPropertyOptional({ example: 'work-type-id-eletrica' })
  @IsOptional()
  @IsString()
  workTypeId?: string;

  @ApiProperty({ example: 800, description: 'Valor adicional em R$' })
  @IsNumber()
  @Min(0)
  additionalAmount!: number;

  @ApiPropertyOptional({ example: 'Urgente - obra parada esperando decisão' })
  @IsOptional()
  @IsString()
  notes?: string;
}
