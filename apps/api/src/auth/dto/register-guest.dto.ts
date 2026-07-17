import { IsString, MinLength } from 'class-validator';

export class RegisterGuestDto {
  @IsString()
  @MinLength(3)
  tenantName!: string;
}
