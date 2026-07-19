import { describe, expect, it } from 'vitest';
import { ArrowLeftRight, Banknote, Tag, TrendingUp } from 'lucide-react';
import { buildProjetoCategoria } from './PorProjetoCategoriaView';
import { getExpenseIcon, getReceiptIcon } from '@/lib/expense-icons';
import type { AccountViewSaida } from '../_types';

const saida = (over: Partial<AccountViewSaida>): AccountViewSaida =>
  ({
    kind: 'saida',
    isInvoice: false,
    tipoDespesa: 'OUTROS',
    valor: 0,
    projetoOrigem: null,
    ...over,
  }) as AccountViewSaida;

describe('buildProjetoCategoria', () => {
  it('agrupa por projeto → categoria, com Pessoal no fallback e fatura sem tipo', () => {
    const grupos = buildProjetoCategoria(
      [
        saida({ tipoDespesa: 'ALIMENTACAO', valor: 1000 }),
        saida({ tipoDespesa: 'ALIMENTACAO', valor: 500 }),
        saida({ isInvoice: true, valor: 200 }),
        saida({
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 3000,
          projetoOrigem: { id: 'ref1', name: 'Reforma X', type: 'REFORMA' },
        }),
      ],
      'self',
    );

    // 2 projetos, ordenados por total desc (Reforma 3000 > Pessoal 1700).
    expect(grupos.map((g) => g.key)).toEqual(['ref1', 'self']);
    const pessoal = grupos[1];
    expect(pessoal.name).toBe('Pessoal');
    expect(pessoal.type).toBe('PESSOAL');
    // Categorias do Pessoal por total desc: ALIMENTACAO (1500, 2 itens) e fatura (200).
    expect(pessoal.categorias[0]).toMatchObject({ tipo: 'ALIMENTACAO', total: 1500, count: 2 });
    const fatura = pessoal.categorias.find((c) => c.label === 'Fatura de cartão');
    expect(fatura?.tipo).toBeNull();
  });
});

describe('ícones de categoria (sem "?")', () => {
  it('valores legados não caem no fallback genérico', () => {
    // TRANSFERENCIA/RENDIMENTO não são membros do enum → antes viravam "?".
    expect(getExpenseIcon('TRANSFERENCIA').Icon).toBe(ArrowLeftRight);
    expect(getReceiptIcon('RENDIMENTO').Icon).toBe(TrendingUp);
    // OUTROS deixou de ser HelpCircle ("?").
    expect(getExpenseIcon('OUTROS').Icon).toBe(Tag);
  });

  it('normaliza caixa e mantém os tipos reais', () => {
    expect(getExpenseIcon('transferencia').Icon).toBe(ArrowLeftRight);
    expect(getReceiptIcon('salario').Icon).toBe(Banknote);
  });
});
