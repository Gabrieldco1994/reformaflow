import { IsString, IsOptional, IsDateString, IsIn } from 'class-validator';

export class CreateReminderDto {
  @IsString() titulo!: string;
  @IsOptional() @IsString() descricao?: string;
  @IsDateString() data!: string;
  @IsOptional() @IsString() @IsIn(['UNICA', 'DIARIA', 'SEMANAL', 'MENSAL', 'ANUAL'])
  recorrencia?: string;
  @IsOptional() @IsString() @IsIn(['PENDENTE', 'CONCLUIDO', 'ADIADO'])
  status?: string;
  @IsOptional() @IsString() @IsIn(['BAIXA', 'MEDIA', 'ALTA', 'URGENTE'])
  prioridade?: string;
}

export class UpdateReminderDto {
  @IsOptional() @IsString() titulo?: string;
  @IsOptional() @IsString() descricao?: string;
  @IsOptional() @IsDateString() data?: string;
  @IsOptional() @IsString() recorrencia?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() prioridade?: string;
}
