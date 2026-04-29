import { IsString, IsNumber, IsOptional, Min, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateContractorDto {
  @ApiProperty({ example: 'João Pedreiro' })
  @IsString()
  @MinLength(3)
  name!: string;

  @ApiPropertyOptional({ example: '***.***.***-**' })
  @IsOptional()
  @IsString()
  document?: string;

  @ApiPropertyOptional({ example: '(11) 99999-0000' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ example: 20000, description: 'Valor total contratado' })
  @IsNumber()
  @Min(0)
  contractedAmount!: number;
}
