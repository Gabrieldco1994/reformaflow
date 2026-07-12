import { IsString, IsOptional, IsIn } from 'class-validator';

const SAUDE_VALUES = ['SAUDAVEL', 'ATENCAO', 'CRITICA'] as const;

export class CreatePlantDto {
  @IsString() nome!: string;
  @IsOptional() @IsString() localizacao?: string;
  @IsOptional() @IsString() observacoes?: string;
}

export class UpdatePlantDto {
  @IsOptional() @IsString() nome?: string;
  @IsOptional() @IsString() localizacao?: string;
  @IsOptional() @IsString() observacoes?: string;
  @IsOptional() @IsIn(SAUDE_VALUES) ultimaSaude?: string;
}
