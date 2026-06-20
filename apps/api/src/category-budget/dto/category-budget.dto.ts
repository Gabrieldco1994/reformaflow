import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

export class UpsertCategoryBudgetDto {
  @IsString()
  tipoDespesa!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  mes?: string | null;

  @IsInt()
  @Min(1)
  valorLimiteCents!: number;
}
