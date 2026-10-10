import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
  Allow,
} from "class-validator";
import { Type } from 'class-transformer';

export class ChatMessageDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @MaxLength(4000)
  content!: string;
}

export class AgentChatDto {
  // The contextual guard validates presence (including null) before this whitelist pipe.
  @Allow()
  importTurn?: unknown;

  @ApiProperty({ type: [ChatMessageDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages!: ChatMessageDto[];

  @ApiProperty({ required: false, description: "Projeto em foco (opcional)." })
  @IsOptional()
  @IsString()
  projectId?: string;
}
