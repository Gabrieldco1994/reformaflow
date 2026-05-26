import { IsString, IsInt, IsOptional, Min, Matches } from 'class-validator';

export class CreateBudgetAllocationDto {
  @IsString()
  targetProjectId!: string;

  @IsOptional()
  @IsString()
  sourceReceiptId?: string;

  @IsInt()
  @Min(1)
  valor!: number; // in cents

  @IsOptional()
  @IsString()
  descricao?: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'mes must be in format YYYY-MM' })
  mes!: string; // YYYY-MM
}
