import { IsString, IsInt, IsBoolean, IsOptional, IsDateString, Min, IsArray, ValidateNested, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

// Config
export class UpsertScheduleConfigDto {
  @IsDateString()
  dataInicio!: string;

  @IsBoolean()
  @IsOptional()
  trabalhaDiasUteis?: boolean;

  @IsBoolean()
  @IsOptional()
  trabalhaSabados?: boolean;

  @IsDateString()
  @IsOptional()
  linhaBaseData?: string;
}

// Stage
export class CreateScheduleStageDto {
  @IsString()
  nome!: string;

  @IsInt()
  @Min(0)
  ordem!: number;
}

export class UpdateScheduleStageDto {
  @IsString()
  @IsOptional()
  nome?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  ordem?: number;
}

// Task
export class CreateScheduleTaskDto {
  @IsString()
  stageId!: string;

  @IsInt()
  numero!: number;

  @IsString()
  nome!: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  duracao?: number;

  @IsDateString()
  @IsOptional()
  dataInicio?: string;

  @IsString()
  @IsOptional()
  predecessoras?: string; // JSON array "[2,3]"

  @IsInt()
  @IsOptional()
  valorOrcado?: number;

  @IsInt()
  @IsOptional()
  custoReal?: number;

  @IsNumber()
  @IsOptional()
  percentualConcluido?: number;

  @IsInt()
  @Min(0)
  ordem!: number;
}

export class UpdateScheduleTaskDto {
  @IsString()
  @IsOptional()
  nome?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  duracao?: number;

  @IsDateString()
  @IsOptional()
  dataInicio?: string;

  @IsString()
  @IsOptional()
  predecessoras?: string;

  @IsInt()
  @IsOptional()
  valorOrcado?: number;

  @IsInt()
  @IsOptional()
  custoReal?: number;

  @IsNumber()
  @IsOptional()
  percentualConcluido?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  ordem?: number;
}

// Holiday
export class CreateScheduleHolidayDto {
  @IsString()
  nome!: string;

  @IsDateString()
  data!: string;
}

// Import
export class ImportStageDto {
  @IsString()
  nome!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportTaskDto)
  tasks!: ImportTaskDto[];
}

export class ImportTaskDto {
  @IsInt()
  numero!: number;

  @IsString()
  nome!: string;

  @IsInt()
  @Min(0)
  duracao!: number;

  @IsDateString()
  @IsOptional()
  dataInicio?: string;

  @IsDateString()
  @IsOptional()
  dataTermino?: string;

  @IsString()
  @IsOptional()
  predecessoras?: string;

  @IsInt()
  @IsOptional()
  valorOrcado?: number;

  @IsInt()
  @IsOptional()
  custoReal?: number;

  @IsNumber()
  @IsOptional()
  percentualConcluido?: number;
}

export class ImportScheduleDto {
  @IsDateString()
  dataInicio!: string;

  @IsBoolean()
  @IsOptional()
  trabalhaDiasUteis?: boolean;

  @IsBoolean()
  @IsOptional()
  trabalhaSabados?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportStageDto)
  stages!: ImportStageDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateScheduleHolidayDto)
  @IsOptional()
  holidays?: CreateScheduleHolidayDto[];
}
