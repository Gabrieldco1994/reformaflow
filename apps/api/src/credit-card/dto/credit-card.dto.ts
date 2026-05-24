import {
  IsIn, IsInt, IsOptional, IsString, Length, Max, Min, Matches,
} from 'class-validator';

const INSTITUTIONS = ['ITAU', 'NUBANK', 'INTER', 'BB', 'CAIXA', 'SANTANDER', 'BRADESCO', 'C6', 'XP', 'OUTRO', 'OUTROS'] as const;
const BRANDS = ['Visa', 'Mastercard', 'Elo', 'Amex', 'Hipercard', 'Diners', 'Outros'] as const;

export class CreateCreditCardDto {
  @IsString() @IsIn(INSTITUTIONS as unknown as string[]) institution!: string;
  @IsString() @IsIn(BRANDS as unknown as string[]) brand!: string;
  @IsOptional() @IsString() @Length(0, 120) nickname?: string;
  @IsString() @Matches(/^\d{4}$/, { message: 'last4 deve ter exatamente 4 dígitos numéricos' }) last4!: string;
  @IsOptional() @IsInt() @Min(0) limitTotalCents?: number;
  @IsOptional() @IsInt() @Min(0) limitAvailableCents?: number;
  @IsOptional() @IsInt() @Min(1) @Max(31) closingDay?: number;
  @IsOptional() @IsInt() @Min(1) @Max(31) dueDay?: number;
  @IsOptional() @IsString() @Length(0, 1000) notes?: string;
}

export class UpdateCreditCardDto {
  @IsOptional() @IsString() @IsIn(INSTITUTIONS as unknown as string[]) institution?: string;
  @IsOptional() @IsString() @IsIn(BRANDS as unknown as string[]) brand?: string;
  @IsOptional() @IsString() @Length(0, 120) nickname?: string;
  @IsOptional() @IsString() @Matches(/^\d{4}$/) last4?: string;
  @IsOptional() @IsInt() @Min(0) limitTotalCents?: number;
  @IsOptional() @IsInt() @Min(0) limitAvailableCents?: number;
  @IsOptional() @IsInt() @Min(1) @Max(31) closingDay?: number;
  @IsOptional() @IsInt() @Min(1) @Max(31) dueDay?: number;
  @IsOptional() @IsString() @Length(0, 1000) notes?: string;
}

export class ImportStatementQueryDto {
  @IsOptional() @IsIn(['AUTO', 'OFX', 'CSV_NUBANK', 'CSV_ITAU', 'CSV_GENERIC', 'PDF']) source?: 'AUTO' | 'OFX' | 'CSV_NUBANK' | 'CSV_ITAU' | 'CSV_GENERIC' | 'PDF';
  @IsOptional() @IsString() periodLabel?: string; // override
  @IsOptional() @IsString() @IsIn(['preview', 'commit']) mode?: 'preview' | 'commit'; // default: preview
  @IsOptional() @IsString() @Length(0, 200) password?: string; // senha do PDF (faturas criptografadas)
}
