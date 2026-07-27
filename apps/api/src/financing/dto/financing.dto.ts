import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class UpsertFinancingDto {
  @IsOptional() @IsString() instituicao?: string;

  @IsIn(['PRICE', 'SAC']) sistema!: string;

  @IsInt() @Min(1) valorTotalFinanciado!: number; // centavos

  @IsInt() @Min(0) @Max(10_000) taxaJurosMensalBps!: number; // limite sensato: até 100% a.m. em bps

  @IsInt() @Min(1) @Max(600) prazoMeses!: number;

  @Matches(DATE_ONLY, { message: 'dataPrimeiraParcela deve estar no formato YYYY-MM-DD' })
  @IsDateString({ strict: true })
  dataPrimeiraParcela!: string;

  @IsInt() @Min(1) @Max(31) diaVencimento!: number;

  @IsOptional() @IsString() observacoes?: string;
}

export class PayInstallmentDto {
  @IsInt() @Min(1) valorPago!: number; // centavos

  @Matches(DATE_ONLY, { message: 'dataPagamento deve estar no formato YYYY-MM-DD' })
  @IsDateString({ strict: true })
  dataPagamento!: string;
}
