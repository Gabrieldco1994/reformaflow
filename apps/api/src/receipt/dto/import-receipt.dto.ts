import { BadRequestException } from '@nestjs/common';
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateBy,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

export const RECEIPT_IMPORT_DOCUMENT_TYPE_BANK = 'bank';
export const RECEIPT_IMPORT_DOCUMENT_TYPE_CARD = 'card';
export const RECEIPT_IMPORT_MODE_PREVIEW = 'preview';
export const RECEIPT_IMPORT_MODE_COMMIT = 'commit';
export const RECEIPT_IMPORT_ACTION_CREATE = 'create';
export const RECEIPT_IMPORT_ACTION_SKIP = 'skip';
/** (#659) força criar uma linha marcada `possibleDuplicate` (Tier B). */
export const RECEIPT_IMPORT_ACTION_IMPORT = 'import';
export const RECEIPT_IMPORT_DOCUMENT_TYPES = [
  RECEIPT_IMPORT_DOCUMENT_TYPE_BANK,
  RECEIPT_IMPORT_DOCUMENT_TYPE_CARD,
] as const;
export const RECEIPT_IMPORT_MODES = [
  RECEIPT_IMPORT_MODE_PREVIEW,
  RECEIPT_IMPORT_MODE_COMMIT,
] as const;
export const BANK_RECEIPT_IMPORT_SOURCES = [
  'AUTO',
  'OFX',
  'CSV_GENERIC',
  'PDF',
] as const;
export const CARD_RECEIPT_IMPORT_SOURCES = [
  'AUTO',
  'OFX',
  'CSV_NUBANK',
  'CSV_ITAU',
  'CSV_GENERIC',
  'PDF',
] as const;
const PERIOD_LABEL_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const RECEIPT_IMPORT_ORIGINS = ['none'] as const;
const RECEIPT_IMPORT_ACTIONS = [
  RECEIPT_IMPORT_ACTION_CREATE,
  RECEIPT_IMPORT_ACTION_SKIP,
  RECEIPT_IMPORT_ACTION_IMPORT,
] as const;
const DECISION_KEYS = new Set(['externalId', 'action', 'overrides']);
const OVERRIDE_KEYS = new Set(['titulo', 'valorCents', 'category']);
const MAX_IMPORT_TEXT_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 100;

export type ReceiptImportDocumentType =
  (typeof RECEIPT_IMPORT_DOCUMENT_TYPES)[number];
export type ReceiptImportSource =
  | (typeof BANK_RECEIPT_IMPORT_SOURCES)[number]
  | (typeof CARD_RECEIPT_IMPORT_SOURCES)[number];
export type ReceiptImportAction = (typeof RECEIPT_IMPORT_ACTIONS)[number];

export interface ReceiptImportDecision {
  externalId: string;
  action?: ReceiptImportAction;
  overrides?: {
    titulo?: string;
    valorCents?: number;
    category?: string;
  };
}

/** Vocabulário de `source` difere por tipo de documento (mesmas fontes dos parsers existentes). */
function IsReceiptImportSource(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isReceiptImportSource',
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (value === undefined) return true;
          const { documentType } = args.object as ImportReceiptQueryDto;
          const sources =
            documentType === RECEIPT_IMPORT_DOCUMENT_TYPE_BANK
              ? BANK_RECEIPT_IMPORT_SOURCES
              : CARD_RECEIPT_IMPORT_SOURCES;
          return (sources as readonly unknown[]).includes(value);
        },
        defaultMessage(args: ValidationArguments): string {
          const { documentType } = args.object as ImportReceiptQueryDto;
          return `source inválido para documentType=${documentType}`;
        },
      },
    },
    validationOptions,
  );
}

export class ImportReceiptQueryDto {
  @IsIn(RECEIPT_IMPORT_ORIGINS as unknown as string[]) origin!: 'none';
  @IsIn(RECEIPT_IMPORT_DOCUMENT_TYPES as unknown as string[])
  documentType!: ReceiptImportDocumentType;
  @IsOptional()
  @IsIn(RECEIPT_IMPORT_MODES as unknown as string[])
  mode?: (typeof RECEIPT_IMPORT_MODES)[number];
  @IsOptional()
  @IsString()
  @IsReceiptImportSource()
  source?: ReceiptImportSource;
  @IsOptional() @IsString() @Matches(PERIOD_LABEL_PATTERN) periodLabel?: string;
  @IsOptional()
  @IsString()
  @Length(0, MAX_IMPORT_TEXT_LENGTH)
  password?: string;
}

export class ImportReceiptBodyDto {
  @IsOptional()
  @IsString()
  decisions?: string;
}

function invalidDecisions(): never {
  throw new BadRequestException({
    message: 'campo "decisions" deve ser um JSON array válido',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sanitiza as decisões do multipart e rejeita campos de vínculo antes de
 * qualquer escrita. A importação Carteira só permite criar ou ignorar linhas.
 */
export function validateReceiptImportDecisions(
  value: unknown,
): ReceiptImportDecision[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalidDecisions();

  const externalIds = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) return invalidDecisions();
    if (Object.keys(candidate).some((key) => !DECISION_KEYS.has(key))) {
      return invalidDecisions();
    }

    const externalId =
      typeof candidate.externalId === 'string'
        ? candidate.externalId.trim()
        : '';
    if (
      externalId.length === 0 ||
      externalId.length > MAX_IMPORT_TEXT_LENGTH ||
      externalIds.has(externalId)
    ) {
      return invalidDecisions();
    }
    externalIds.add(externalId);

    const action = candidate.action;
    if (
      action !== undefined &&
      !RECEIPT_IMPORT_ACTIONS.includes(action as ReceiptImportAction)
    ) {
      return invalidDecisions();
    }

    const overrides = candidate.overrides;
    if (overrides !== undefined && !isRecord(overrides)) {
      return invalidDecisions();
    }
    if (
      overrides &&
      Object.keys(overrides).some((key) => !OVERRIDE_KEYS.has(key))
    ) {
      return invalidDecisions();
    }

    const titulo = overrides?.titulo;
    if (
      titulo !== undefined &&
      (typeof titulo !== 'string' ||
        titulo.trim().length === 0 ||
        titulo.length > MAX_IMPORT_TEXT_LENGTH)
    ) {
      return invalidDecisions();
    }

    const valorCents = overrides?.valorCents;
    if (valorCents !== undefined && !Number.isSafeInteger(valorCents)) {
      return invalidDecisions();
    }

    const category = overrides?.category;
    if (
      category !== undefined &&
      (typeof category !== 'string' ||
        category.trim().length === 0 ||
        category.length > MAX_CATEGORY_LENGTH)
    ) {
      return invalidDecisions();
    }

    if (action === undefined && overrides === undefined) {
      return invalidDecisions();
    }

    return {
      externalId,
      ...(action !== undefined && { action: action as ReceiptImportAction }),
      ...(overrides !== undefined && {
        overrides: {
          ...(titulo !== undefined && { titulo: titulo.trim() }),
          ...(valorCents !== undefined && {
            valorCents: valorCents as number,
          }),
          ...(category !== undefined && { category: category.trim() }),
        },
      }),
    };
  });
}

export function parseReceiptImportDecisions(
  raw: string | undefined,
): ReceiptImportDecision[] | undefined {
  if (raw === undefined) return undefined;
  try {
    return validateReceiptImportDecisions(JSON.parse(raw));
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    return invalidDecisions();
  }
}
