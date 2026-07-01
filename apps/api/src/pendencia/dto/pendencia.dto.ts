import { IsString, IsOptional, IsDateString, IsIn, IsInt, IsNotEmpty, Min } from 'class-validator';
import { PendenciaStatus } from '@reformaflow/domain';

const STATUS_VALUES = Object.values(PendenciaStatus);

export class CreatePendenciaDto {
  @IsString() @IsNotEmpty() title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() @IsIn(STATUS_VALUES) status?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() owner?: string;
  @IsOptional() @IsString() roomId?: string;
  @IsOptional() @IsString() scheduleTaskId?: string;
}

export class UpdatePendenciaDto {
  @IsOptional() @IsString() @IsNotEmpty() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() @IsIn(STATUS_VALUES) status?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() owner?: string;
  @IsOptional() @IsString() roomId?: string;
  @IsOptional() @IsString() scheduleTaskId?: string;
  @IsOptional() @IsInt() @Min(0) order?: number;
}

export class MovePendenciaDto {
  @IsString() @IsIn(STATUS_VALUES) status!: string;
  @IsInt() @Min(0) order!: number;
}
