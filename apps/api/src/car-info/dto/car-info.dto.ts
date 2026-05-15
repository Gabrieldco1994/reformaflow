import { IsOptional, IsString, IsInt, Min } from 'class-validator';

export class UpsertCarInfoDto {
  @IsOptional() @IsString() marca?: string;
  @IsOptional() @IsString() modelo?: string;
  @IsOptional() @IsInt() anoFabricacao?: number;
  @IsOptional() @IsInt() anoModelo?: number;
  @IsOptional() @IsString() cor?: string;
  @IsOptional() @IsString() placa?: string;
  @IsOptional() @IsInt() @Min(0) tabelaFipe?: number;
  @IsOptional() @IsInt() @Min(0) valorPago?: number;
  @IsOptional() @IsInt() @Min(0) kmAtual?: number;
  @IsOptional() @IsInt() @Min(0) kmUltimaRevisao?: number;
}
