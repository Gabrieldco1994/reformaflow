import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const VEHICLE_DOCUMENT_TYPES = [
  'IPVA',
  'SEGURO',
  'LICENCIAMENTO',
  'OUTRO',
] as const;

export class CreateVehicleDocumentDto {
  @IsString()
  @IsIn(VEHICLE_DOCUMENT_TYPES)
  tipo!: string;

  @IsString()
  titulo!: string;

  @IsOptional()
  @IsString()
  numero?: string;

  @IsDateString()
  dataVencimento!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  lembreteAntecedenciaDias?: number;

  @IsOptional()
  @IsString()
  observacoes?: string;
}

export class UpdateVehicleDocumentDto {
  @IsOptional()
  @IsString()
  @IsIn(VEHICLE_DOCUMENT_TYPES)
  tipo?: string;

  @IsOptional()
  @IsString()
  titulo?: string;

  @IsOptional()
  @IsString()
  numero?: string;

  @IsOptional()
  @IsDateString()
  dataVencimento?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  lembreteAntecedenciaDias?: number;

  @IsOptional()
  @IsString()
  observacoes?: string;
}
