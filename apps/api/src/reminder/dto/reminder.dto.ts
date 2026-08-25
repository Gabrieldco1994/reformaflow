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
  // Vínculo opcional com uma planta (PLANTAS). O campo já existe no schema
  // (nullable) e hoje só é gravado internamente por plants-ai.service.ts —
  // aqui expomos a mesma capacidade na API pública de lembretes. Validado
  // contra tenantId+projectId em ReminderService.create antes de gravar
  // (nunca confiar cegamente num id vindo do cliente).
  @IsOptional() @IsString() plantId?: string;
}

export class UpdateReminderDto {
  @IsOptional() @IsString() titulo?: string;
  @IsOptional() @IsString() descricao?: string;
  @IsOptional() @IsDateString() data?: string;
  @IsOptional() @IsString() @IsIn(['UNICA', 'DIARIA', 'SEMANAL', 'MENSAL', 'ANUAL'])
  recorrencia?: string;
  @IsOptional() @IsString() @IsIn(['PENDENTE', 'CONCLUIDO', 'ADIADO'])
  status?: string;
  @IsOptional() @IsString() @IsIn(['BAIXA', 'MEDIA', 'ALTA', 'URGENTE'])
  prioridade?: string;
}
