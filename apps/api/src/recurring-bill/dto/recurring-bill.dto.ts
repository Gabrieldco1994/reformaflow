import { IsString, IsOptional, IsNumber, IsIn, Min, Max } from 'class-validator';

export class CreateRecurringBillDto {
  @IsString() nome!: string;
  @IsNumber() valor!: number; // centavos
  @IsString() @IsIn(['LUZ', 'AGUA', 'INTERNET', 'IPTU', 'CONDOMINIO', 'SEGURO', 'GAS', 'TELEFONE', 'STREAMING', 'OUTRO'])
  categoria!: string;
  @IsOptional() @IsString() @IsIn(['MENSAL', 'BIMESTRAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL'])
  frequencia?: string;
  @IsNumber() @Min(1) @Max(31) diaVencimento!: number;
  @IsOptional() @IsString() @IsIn(['ATIVO', 'PAUSADO']) status?: string;
  @IsOptional() @IsString() observacoes?: string;
}

export class UpdateRecurringBillDto {
  @IsOptional() @IsString() nome?: string;
  @IsOptional() @IsNumber() valor?: number;
  @IsOptional() @IsString() categoria?: string;
  @IsOptional() @IsString() frequencia?: string;
  @IsOptional() @IsNumber() diaVencimento?: number;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() observacoes?: string;
}
