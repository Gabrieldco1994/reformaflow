import { IsString, IsOptional } from 'class-validator';

export class CreatePlantDto {
  @IsString() nome!: string;
  @IsOptional() @IsString() localizacao?: string;
  @IsOptional() @IsString() observacoes?: string;
}

export class UpdatePlantDto {
  @IsOptional() @IsString() nome?: string;
  @IsOptional() @IsString() localizacao?: string;
  @IsOptional() @IsString() observacoes?: string;
}
