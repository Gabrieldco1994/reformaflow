import { describe, expect, it } from 'vitest';
import { LAUNCH_MODES, ONBOARDING_MODES } from './launch-modes';

/**
 * O PR #391 renomeou o modo `foto` para "Fatura / Extrato" e foi revertido: o
 * painel da jornada reusava os rótulos de `LAUNCH_MODES` e já tem um botão
 * "Importar", então a mesma tela passou a ter dois caminhos com nomes
 * equivalentes para funções diferentes. Estes testes prendem as duas regras
 * que faltavam.
 */
describe('rótulos dos modos de lançamento', () => {
  // Rótulos fixos do painel da jornada (ExpenseAndImportUnifiedStep). Se algum
  // mudar lá, este teste falha e obriga a revisitar a colisão.
  const ROTULOS_DO_PAINEL = ['Lançar despesa', 'Importar'];

  it('nenhum modo do onboarding colide com os botões já existentes no painel', () => {
    for (const modo of ONBOARDING_MODES) {
      for (const fixo of ROTULOS_DO_PAINEL) {
        expect(modo.label.toLowerCase()).not.toBe(fixo.toLowerCase());
        // "Fatura / Extrato" ao lado de "Importar" é a colisão do #391: dois
        // nomes para a mesma ideia, um deles já ocupado.
        expect(modo.label.toLowerCase()).not.toMatch(/fatura|extrato/);
      }
    }
  });

  it('cada modo do onboarding tem rótulo único', () => {
    const rotulos = ONBOARDING_MODES.map((m) => m.label);
    expect(new Set(rotulos).size).toBe(rotulos.length);
  });

  // O `accept` do modo foto no onboarding é `image/*`. Prometer PDF/CSV/XLS ali
  // faz o usuário tentar e falhar — pior que um subtítulo genérico.
  it('o modo foto do onboarding não promete formato que o seletor recusa', () => {
    const foto = ONBOARDING_MODES.find((m) => m.value === 'foto');
    expect(foto).toBeDefined();
    expect(foto!.subtitle ?? '').not.toMatch(/pdf|csv|ofx|xls|txt/i);
  });

  // No menu "+" o modo foto leva a fatura/extrato, cujos modais aceitam esses
  // formatos — lá a promessa é verdadeira e deve continuar existindo.
  it('no menu "+" os modos de arquivo listam os formatos aceitos', () => {
    for (const value of ['fatura', 'extrato', 'foto'] as const) {
      const modo = LAUNCH_MODES.find((m) => m.value === value);
      expect(modo?.subtitle ?? '').toMatch(/PDF/);
    }
  });
});
