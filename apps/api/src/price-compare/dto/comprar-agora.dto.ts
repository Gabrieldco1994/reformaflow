import { IsDateString, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ComprarAgoraDto {
  @IsInt()
  @Min(1)
  quantidade!: number;

  @IsIn(['A_VISTA', 'PARCELADO'])
  formaPagamento!: 'A_VISTA' | 'PARCELADO';

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(360)
  parcelas?: number;

  @IsOptional()
  @IsDateString()
  dataInicio?: string;

  @IsOptional()
  @IsDateString()
  dataCompra?: string;
}
