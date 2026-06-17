import {
  IsIn, IsInt, IsISO8601, IsOptional, IsString, Length, Matches, Max, Min,
} from 'class-validator';

const INSTITUTIONS = ['ITAU', 'NUBANK', 'INTER', 'BB', 'CAIXA', 'SANTANDER', 'BRADESCO', 'C6', 'XP', 'OUTRO', 'OUTROS'] as const;

export class CreateBankAccountDto {
  @IsString() @IsIn(INSTITUTIONS as unknown as string[]) institution!: string;
  @IsOptional() @IsString() @Length(0, 120) nickname?: string;
  @IsOptional() @IsString() @Length(0, 30) agency?: string;
  @IsOptional() @IsString() @Length(0, 30) accountNumber?: string;
  @IsString() @Matches(/^\d{4}$/, { message: 'last4 deve ter exatamente 4 dígitos numéricos' }) last4!: string;
  @IsOptional() @IsString() @Length(0, 1000) notes?: string;
  @IsOptional() @IsInt() openingBalanceCents?: number; // saldo inicial em centavos (base da reconciliação §10)
  @IsOptional() @IsISO8601() openingBalanceDate?: string; // data de referência do saldo inicial (ISO)
}

export class UpdateBankAccountDto {
  @IsOptional() @IsString() @IsIn(INSTITUTIONS as unknown as string[]) institution?: string;
  @IsOptional() @IsString() @Length(0, 120) nickname?: string;
  @IsOptional() @IsString() @Length(0, 30) agency?: string;
  @IsOptional() @IsString() @Length(0, 30) accountNumber?: string;
  @IsOptional() @IsString() @Matches(/^\d{4}$/) last4?: string;
  @IsOptional() @IsString() @Length(0, 1000) notes?: string;
  @IsOptional() @IsInt() openingBalanceCents?: number;
  @IsOptional() @IsISO8601() openingBalanceDate?: string;
}

export class ImportBankStatementQueryDto {
  @IsOptional() @IsIn(['AUTO', 'OFX', 'CSV_GENERIC', 'PDF']) source?: 'AUTO' | 'OFX' | 'CSV_GENERIC' | 'PDF';
  @IsOptional() @IsString() periodLabel?: string;
  @IsOptional() @IsString() @IsIn(['preview', 'commit']) mode?: 'preview' | 'commit';
  @IsOptional() @IsString() @Length(0, 200) password?: string;
}

export class LinkToExpenseDto {
  @IsString() @Length(1, 50) targetExpenseId!: string;
  /** Parcela 0-based do ALVO a liquidar (default 0). */
  @IsOptional() @IsInt() @Min(0) @Max(120) parcelaIndex?: number;
  /** Valor real da parcela em centavos (default: valor da despesa fonte). */
  @IsOptional() @IsInt() @Min(0) realValor?: number;
}

export class LinkToReceiptDto {
  @IsString() @Length(1, 50) targetReceiptId!: string;
}
