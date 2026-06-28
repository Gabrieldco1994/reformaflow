import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class RateioItemDto {
  @ApiProperty({ description: 'ID da despesa planejada (alvo) que receberá parte da compra' })
  @IsString()
  targetExpenseId!: string;

  @ApiProperty({ description: 'Valor alocado a esta planejada, em centavos' })
  @IsInt()
  @Min(1)
  allocation!: number;
}

export class RatearDto {
  @ApiProperty({ type: [RateioItemDto], description: 'Distribuição da compra entre planejadas' })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RateioItemDto)
  allocations!: RateioItemDto[];
}
