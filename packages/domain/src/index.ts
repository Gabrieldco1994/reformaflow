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
// Builders de fixture de Jornada. Dado puro (sem framework de teste), exportado
// pelo barrel porque três runners diferentes os consomem: vitest no domínio,
// jest na API e vitest no web.
export * from './testing/journey-builders';

