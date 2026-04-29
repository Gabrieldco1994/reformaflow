import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ApproveChangeOrderDto {
  @ApiProperty({ example: 'Gabriel Barbosa' })
  @IsString()
  approvedBy!: string;
}
