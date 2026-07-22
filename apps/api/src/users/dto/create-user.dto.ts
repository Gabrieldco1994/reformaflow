import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export const PLANTS_AI_MODULE_SLUG = 'plantsAi';

export const MODULE_SLUGS = [
  'dashboard',
  'expenses',
  'receipts',
  'cashFlow',
  'monthlyOverview',
  'rooms',
  'floorPlans',
  'simulation',
  'priceCompare',
  'recurringBills',
  'maintenance',
  'reminders',
  'carInfo',
  'vehicleDocuments',
  'financing',
  'creditCards',
  'bankAccounts',
  'schedule',
  'financialDashboard',
  PLANTS_AI_MODULE_SLUG,
] as const;

export const PROJECT_TYPES = ['REFORMA', 'COMPRA', 'CASA', 'CARRO', 'PESSOAL', 'PLANTAS'] as const;

export class CreateUserDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(40)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'Usuário deve conter apenas letras, números, ponto, hífen ou sublinhado',
  })
  username!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsOptional()
  @IsIn(['ADMIN', 'USER'])
  role?: 'ADMIN' | 'USER';

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(MODULE_SLUGS as unknown as string[], { each: true })
  allowedModules?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  allowedProjects?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(PROJECT_TYPES as unknown as string[], { each: true })
  allowedProjectTypes?: string[];
}
