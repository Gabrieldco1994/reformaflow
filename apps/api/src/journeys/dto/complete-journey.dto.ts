import { IsOptional, IsString } from 'class-validator';

/**
 * `POST /journeys/:id/complete`. `triggerId` é obrigatório — vem direto da
 * resposta de `GET /journeys/eligible` (o cliente nunca adivinha QUAL
 * gatilho está completando, então nunca há ambiguidade sobre `repeatPolicy`).
 */
export class CompleteJourneyDto {
  @IsString()
  triggerId!: string;

  @IsOptional()
  @IsString()
  projectId?: string;
}
