import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import {
  IMPORT_CHAT_CHANNEL,
  type ImportChatChannel,
} from "@reformaflow/domain";

const IMPORT_CHAT_CHANNELS = Object.values(IMPORT_CHAT_CHANNEL);

export class ChatMessageDto {
  @ApiProperty({ enum: ["user", "assistant"] })
  @IsIn(["user", "assistant"])
  role!: "user" | "assistant";

  @ApiProperty()
  @IsString()
  @MaxLength(4000)
  content!: string;
}

export class AgentChatMetadataDto {
  @ApiProperty({
    required: false,
    enum: IMPORT_CHAT_CHANNELS,
    default: IMPORT_CHAT_CHANNEL.TEXT,
    description: "Proveniência do turno; não concede autorização.",
  })
  @IsOptional()
  @IsIn(IMPORT_CHAT_CHANNELS)
  channel?: ImportChatChannel;
}

export class AgentChatDto {
  @ApiProperty({ type: [ChatMessageDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages!: ChatMessageDto[];

  @ApiProperty({ required: false, type: AgentChatMetadataDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AgentChatMetadataDto)
  metadata?: AgentChatMetadataDto;

  @ApiProperty({ required: false, description: "Projeto em foco (opcional)." })
  @IsOptional()
  @IsString()
  projectId?: string;
}
