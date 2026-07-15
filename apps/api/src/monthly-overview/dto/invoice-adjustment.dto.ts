import { IsIn, IsInt, IsOptional, IsString, Length, Matches } from 'class-validator';

const ADJUSTMENT_REASONS = [
  'JUROS_ROTATIVO',
  'IOF',
  'ESTORNO',
  'CONTESTACAO',
  'OUTRO',
  'QUITACAO_RESIDUO',
] as const;

export class CreateInvoiceAdjustmentDto {
  @IsString()
  @Matches(/^\d{4}$/)
  cardLast4!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  dueMonth!: string;

  @IsInt()
  amountCents!: number;

  @IsString()
  @IsIn(ADJUSTMENT_REASONS as unknown as string[])
  reason!: (typeof ADJUSTMENT_REASONS)[number];

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  note?: string;
}
