export * from './enums';
export * from './taxonomy/expense-taxonomy';
export * from './types';
export * from './calculations';
export * from './calculations/schedule-engine';
export * from './calculations/empreiteiro-allocation';
export * from './calculations/monthly-projection';
export * from './seed';
export * from './config';
export * from './voice/expense-voice-parser';
export * from './price-monitor';
// NÃO exportar `./testing/*` aqui: são builders de fixture (com sequência
// mutável de ids) e não fazem parte da API pública do domínio. Testes os
// importam pelo caminho direto do módulo — ver o cabeçalho de
// `testing/journey-builders.ts`.
