import { describe, expect, it } from 'vitest';
import { decodeExpenseQuery, encodeExpenseQuery } from './expense-query-state';

const reformaOptions = {
  projectType: 'REFORMA',
  hasRooms: true,
  storedViewMode: 'month',
  defaultViewMode: 'category',
} as const;

describe('expense query state codec', () => {
  it('resolves view from valid URL, then valid storage, then the category default', () => {
    expect(decodeExpenseQuery(new URLSearchParams('view=general'), reformaOptions).view).toBe(
      'general',
    );
    expect(decodeExpenseQuery(new URLSearchParams(), reformaOptions).view).toBe('month');
    expect(
      decodeExpenseQuery(new URLSearchParams('view=invalid'), {
        ...reformaOptions,
        storedViewMode: 'invalid',
      }).view,
    ).toBe('category');
  });

  it('rejects project view outside PESSOAL and canonicalizes invalid known params', () => {
    const current = new URLSearchParams(
      'view=project&period=2026-07&rangeStart=2026-01&rangeEnd=2026-12&origin=card%3Avisa&utm_source=app',
    );
    const state = decodeExpenseQuery(current, reformaOptions);
    const next = encodeExpenseQuery(current, state, reformaOptions);

    expect(state).toMatchObject({
      view: 'month',
      period: '',
      rangeStart: '',
      rangeEnd: '',
      origin: '',
    });
    expect(next.toString()).toBe('view=month&utm_source=app');
  });

  it('gates room to REFORMA and project/period/range/origin to PESSOAL', () => {
    const params = new URLSearchParams(
      'view=project&room=Su%C3%ADte&period=2026-07&rangeStart=2026-01&rangeEnd=2026-12&origin=account%3Amain',
    );
    const personal = decodeExpenseQuery(params, {
      ...reformaOptions,
      projectType: 'PESSOAL',
      hasRooms: false,
    });
    expect(personal).toMatchObject({
      view: 'project',
      room: '',
      period: '2026-07',
      rangeStart: '2026-01',
      rangeEnd: '2026-12',
      origin: 'account:main',
    });

    const reforma = decodeExpenseQuery(params, reformaOptions);
    expect(reforma.room).toBe('Suíte');
    expect(reforma.origin).toBe('');
  });

  it('round-trips canonical legacy filters and preserves unknown query params', () => {
    const current = new URLSearchParams(
      'q=argamassa&tipoDespesa=MATERIAL_CONSTRUCAO&titulo=Piso&fornecedor=Loja+A&formaPagamento=PARCELADO&status=PLANEJADO&view=general&utm_campaign=julho',
    );
    const state = decodeExpenseQuery(current, reformaOptions);
    const next = encodeExpenseQuery(current, state, reformaOptions);

    expect(state).toMatchObject({
      q: 'argamassa',
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      titulo: 'Piso',
      fornecedor: 'Loja A',
      formaPagamento: 'PARCELADO',
      status: 'PLANEJADO',
      view: 'general',
    });
    expect(next.get('utm_campaign')).toBe('julho');
    expect(decodeExpenseQuery(next, reformaOptions)).toEqual(state);

    const changed = encodeExpenseQuery(
      new URLSearchParams('utm_tag=first&utm_tag=second&feature_flag=mobile&q=old'),
      { ...state, q: 'new' },
      reformaOptions,
    );
    expect(changed.getAll('utm_tag')).toEqual(['first', 'second']);
    expect(changed.getAll('q')).toEqual(['new']);
    expect(changed.get('feature_flag')).toBe('mobile');
  });
});
