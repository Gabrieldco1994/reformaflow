import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

const MES_ONLY = /^\d{4}-(0[1-9]|1[0-2])$/;

export class CreateScenarioDto {
  @IsString() nome!: string;

  @IsOptional() @IsIn([3, 6, 12]) horizonteMeses?: number;
}

export class UpdateScenarioDto {
  @IsOptional() @IsString() nome?: string;

  @IsOptional() @IsIn([3, 6, 12]) horizonteMeses?: number;
}

export class CreateScenarioItemDto {
  @IsString() nome!: string;

  @IsIn(['A_VISTA', 'PARCELADO', 'FINANCIAMENTO']) tipo!: string;

  @IsInt() @Min(1) valorCents!: number;

  @Matches(MES_ONLY, { message: 'mesInicio deve estar no formato YYYY-MM' })
  mesInicio!: string;

  @IsOptional() @IsBoolean() incluido?: boolean;

  // Só FINANCIAMENTO
  @IsOptional() @IsInt() @Min(0) entradaCents?: number;
  @IsOptional() @IsInt() @Min(0) taxaJurosMensalBps?: number;
  @IsOptional() @IsIn(['PRICE', 'SAC']) sistema?: string;

  // PARCELADO | FINANCIAMENTO
  @IsOptional() @IsInt() @Min(1) parcelas?: number;

  // Deep-link do item monitorado (COMPRA) que originou este item
  @IsOptional() @IsString() sourcePriceItemId?: string;
}

export class UpdateScenarioItemDto {
  @IsOptional() @IsString() nome?: string;
  @IsOptional() @IsIn(['A_VISTA', 'PARCELADO', 'FINANCIAMENTO']) tipo?: string;
  @IsOptional() @IsInt() @Min(1) valorCents?: number;
  @IsOptional() @Matches(MES_ONLY, { message: 'mesInicio deve estar no formato YYYY-MM' })
  mesInicio?: string;
  @IsOptional() @IsBoolean() incluido?: boolean;
  @IsOptional() @IsInt() @Min(0) entradaCents?: number;
  @IsOptional() @IsInt() @Min(0) taxaJurosMensalBps?: number;
  @IsOptional() @IsIn(['PRICE', 'SAC']) sistema?: string;
  @IsOptional() @IsInt() @Min(1) parcelas?: number;
  @IsOptional() @IsString() sourcePriceItemId?: string;
}
