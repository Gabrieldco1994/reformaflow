import { describe, it, expect } from 'vitest';
import { hasFeature } from '../src/config';
import { ProjectType } from '../src/enums';

/**
 * #218 (W5, redesenho pos-revert #656) - `bankAccounts` e feature exclusiva de
 * PESSOAL em `PROJECT_FEATURES`.
 *
 * Raiz do dead-end da #655: em REFORMA/COMPRA a oferta de "importar extrato
 * bancario" (no `PayOptionsModal` compartilhado do `ExpensesView`) levava a
 * `GET /projects/:id/bank-accounts` -> 403 mascarado como `[]`. O gate correto
 * no front e `hasFeature(type,'bankAccounts') && hasModule('bankAccounts')`
 * (padrao de `BankAccountsSection.tsx`). Este teste trava so a metade
 * `hasFeature` da invariante - a foto de capacidade do produto.
 *
 * NAO forcar equivalencia entre `PROJECT_FEATURES`, `TYPE_MODULES` e
 * `PROJECT_NAV` (regra do repo / veto do PO): sao mapas de proposito distinto.
 * Aqui so documentamos o conteudo de `PROJECT_FEATURES`.
 */
describe('#218 - bankAccounts e feature so de PESSOAL (PROJECT_FEATURES)', () => {
  it('PESSOAL tem a feature bankAccounts', () => {
    expect(hasFeature(ProjectType.PESSOAL, 'bankAccounts')).toBe(true);
  });

  it('nenhum outro tipo de projeto tem bankAccounts', () => {
    const outros = [
      ProjectType.REFORMA,
      ProjectType.COMPRA,
      ProjectType.CASA,
      ProjectType.CARRO,
      ProjectType.PLANTAS,
    ];
    for (const tipo of outros) {
      expect(hasFeature(tipo, 'bankAccounts')).toBe(false);
    }
  });

  it('assimetria creditCards x bankAccounts em REFORMA/COMPRA - a causa do bug', () => {
    // O fluxo de fatura de cartao funciona em REFORMA/COMPRA porque a
    // AUTORIZACAO (`TYPE_MODULES`/`allowedModules`) concede `creditCards`.
    // `bankAccounts` nao e concedido em nenhum dos dois mapas - dai "Extrato
    // bancario" dava 403 e "Fatura de cartao" nao. O gate do front tem que
    // barrar so o extrato.
    expect(hasFeature(ProjectType.REFORMA, 'bankAccounts')).toBe(false);
    expect(hasFeature(ProjectType.COMPRA, 'bankAccounts')).toBe(false);
  });
});
