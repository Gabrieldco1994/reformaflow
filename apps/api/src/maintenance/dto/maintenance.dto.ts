import { IsString, IsOptional, IsNumber, IsDateString } from 'class-validator';

export class CreateMaintenanceLogDto {
  @IsString() tipo!: string;
  @IsDateString() dataRealizada!: string;
  @IsOptional() @IsDateString() dataProxima?: string;
  @IsOptional() @IsNumber() quilometragem?: number;
  @IsOptional() @IsNumber() custo?: number; // centavos
  @IsOptional() @IsString() fornecedor?: string;
  @IsOptional() @IsString() observacoes?: string;
}

export class UpdateMaintenanceLogDto {
  @IsOptional() @IsString() tipo?: string;
  @IsOptional() @IsDateString() dataRealizada?: string;
  @IsOptional() @IsDateString() dataProxima?: string;
  @IsOptional() @IsNumber() quilometragem?: number;
  @IsOptional() @IsNumber() custo?: number;
  @IsOptional() @IsString() fornecedor?: string;
  @IsOptional() @IsString() observacoes?: string;
}
