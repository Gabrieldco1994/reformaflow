import { IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateBudgetItemDto {
  @ApiProperty({ example: 5000, description: 'Valor previsto em R$' })
  @IsNumber()
  @Min(0)
  planned!: number;
}
