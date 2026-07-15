import { useMemo, useReducer } from 'react';
import { isSinglePaymentForm } from '@reformaflow/domain';
import { reaisToCents } from '../_lib/money';
import type { CrossExpenseLite, NewTargetDraft } from '../_types';

// ── Tipos do wizard ──────────────────────────────────────────────────────────
export type WizardMode = 'PLANEJAR' | 'PAGA';
export type WizardStep = 'DADOS' | 'PAGAMENTO' | 'ACAO' | 'CESTO';

/** Rascunho do form da despesa-fonte. Todos os campos string, exceto `recorrente`. */
export interface WizardDraft {
  tipoDespesa: string;
  categoriaMaoDeObra: string;
  roomId: string;
  valor: string;
  quantidade: string;
  titulo: string;
  fornecedor: string;
  link: string;
  imageUrl: string;
  dataCompra: string;
  recorrente: boolean;
  recorrenciaFim: string;
  formaPagamento: string;
  dataPagamento: string;
  quantidadeParcela: string;
  dataInicioParcela: string;
  creditCardId: string;
  bankAccountId: string;
}

export type BasketRow =
  | { id: string; kind: 'EXISTING'; target: CrossExpenseLite; allocation: number }
  | { id: string; kind: 'NEW'; draft: NewTargetDraft; allocation: number; createdId?: string };

export interface WizardState {
  mode: WizardMode;
  step: WizardStep;
  draft: WizardDraft;
  basket: BasketRow[];
  /** Contador interno monotônico p/ ids determinísticos das linhas do cesto. */
  seq: number;
  /** true assim que o usuário edita tipoDespesa manualmente — bloqueia sugestões futuras da IA. */
  tipoDespesaTouched: boolean;
}

export type WizardAction =
  | { type: 'START'; mode: WizardMode }
  | { type: 'SET_DRAFT'; patch: Partial<WizardDraft> }
  | { type: 'NEXT'; isReforma?: boolean }
  | { type: 'BACK' }
  | { type: 'GO_BASKET' }
  | { type: 'BASKET_ADD_EXISTING'; target: CrossExpenseLite }
  | { type: 'BASKET_ADD_NEW'; draft: NewTargetDraft }
  | { type: 'BASKET_SET_ALLOC'; id: string; cents: number }
  | { type: 'BASKET_FILL_REMAINING'; id: string }
  | { type: 'BASKET_REMOVE'; id: string }
  | { type: 'RESET' }
  | { type: 'APPLY_SUGGESTION'; tipoDespesa: string };

const STEP_ORDER: WizardStep[] = ['DADOS', 'PAGAMENTO', 'ACAO', 'CESTO'];

// ── Fábricas ─────────────────────────────────────────────────────────────────
export function makeEmptyWizardDraft(): WizardDraft {
  return {
    tipoDespesa: '',
    categoriaMaoDeObra: '',
    roomId: '',
    valor: '',
    quantidade: '1',
    titulo: '',
    fornecedor: '',
    link: '',
    imageUrl: '',
    dataCompra: '',
    recorrente: false,
    recorrenciaFim: '',
    formaPagamento: '',
    dataPagamento: '',
    quantidadeParcela: '',
    dataInicioParcela: '',
    creditCardId: '',
    bankAccountId: '',
  };
}

export function makeInitialWizardState(mode: WizardMode = 'PLANEJAR'): WizardState {
  return {
    mode,
    step: 'DADOS',
    draft: makeEmptyWizardDraft(),
    basket: [],
    seq: 0,
    tipoDespesaTouched: false,
  };
}

// ── Guardas puras ────────────────────────────────────────────────────────────
export function canAdvanceDados(state: WizardState, opts: { isReforma: boolean }): boolean {
  const { draft } = state;
  if (draft.tipoDespesa === '') return false;
  if (!(reaisToCents(draft.valor) > 0)) return false;
  if (!(Number(draft.quantidade) >= 1)) return false;
  if (draft.tipoDespesa === 'MAO_DE_OBRA' && opts.isReforma && draft.categoriaMaoDeObra === '') {
    return false;
  }
  return true;
}

export function canAdvancePagamento(state: WizardState): boolean {
  const { draft, mode } = state;
  const fp = draft.formaPagamento;
  if (fp === '') return false;
  if (fp === 'PARCELADO' || fp === 'QUINZENAL') {
    return Number(draft.quantidadeParcela) >= 1;
  }
  if (mode === 'PAGA' && isSinglePaymentForm(fp)) {
    return draft.dataPagamento !== '';
  }
  return true;
}

/** Total da compra-fonte em centavos: valor(reais) × quantidade. */
export function totalFonteCents(draft: WizardDraft): number {
  return reaisToCents(draft.valor) * Number(draft.quantidade || 1);
}

/** Sobra a alocar (centavos): total − Σ das alocações do cesto. */
export function sobraCents(state: WizardState): number {
  const total = totalFonteCents(state.draft);
  const alocado = state.basket.reduce((acc, r) => acc + r.allocation, 0);
  return total - alocado;
}

export function canSaveBasket(state: WizardState): boolean {
  if (state.basket.length < 1) return false;
  if (sobraCents(state) !== 0) return false;
  return state.basket.every((r) => r.allocation > 0);
}

// ── Reducer puro ─────────────────────────────────────────────────────────────
export function novaDespesaReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'START':
      return makeInitialWizardState(action.mode);

    case 'SET_DRAFT':
      return {
        ...state,
        draft: { ...state.draft, ...action.patch },
        tipoDespesaTouched:
          action.patch.tipoDespesa !== undefined ? true : state.tipoDespesaTouched,
      };

    case 'NEXT': {
      const i = STEP_ORDER.indexOf(state.step);
      if (i < 0 || i === STEP_ORDER.length - 1) return state;
      if (state.step === 'DADOS' && !canAdvanceDados(state, { isReforma: !!action.isReforma })) {
        return state;
      }
      if (state.step === 'PAGAMENTO' && !canAdvancePagamento(state)) {
        return state;
      }
      return { ...state, step: STEP_ORDER[i + 1] };
    }

    case 'BACK': {
      const i = STEP_ORDER.indexOf(state.step);
      if (i <= 0) return state;
      return { ...state, step: STEP_ORDER[i - 1] };
    }

    case 'GO_BASKET':
      return { ...state, step: 'CESTO' };

    case 'BASKET_ADD_EXISTING': {
      const id = `row-${state.seq}`;
      const row: BasketRow = { id, kind: 'EXISTING', target: action.target, allocation: 0 };
      return { ...state, basket: [...state.basket, row], seq: state.seq + 1 };
    }

    case 'BASKET_ADD_NEW': {
      const id = `row-${state.seq}`;
      const row: BasketRow = { id, kind: 'NEW', draft: action.draft, allocation: 0 };
      return { ...state, basket: [...state.basket, row], seq: state.seq + 1 };
    }

    case 'BASKET_SET_ALLOC':
      return {
        ...state,
        basket: state.basket.map((r) =>
          r.id === action.id ? { ...r, allocation: Math.max(0, Math.round(action.cents)) } : r,
        ),
      };

    case 'BASKET_FILL_REMAINING': {
      const total = totalFonteCents(state.draft);
      const alocado = state.basket.reduce((acc, r) => acc + r.allocation, 0);
      return {
        ...state,
        basket: state.basket.map((r) =>
          r.id === action.id
            ? { ...r, allocation: Math.max(0, total - (alocado - r.allocation)) }
            : r,
        ),
      };
    }

    case 'BASKET_REMOVE':
      return { ...state, basket: state.basket.filter((r) => r.id !== action.id) };

    case 'RESET':
      return makeInitialWizardState(state.mode);

    case 'APPLY_SUGGESTION':
      if (state.tipoDespesaTouched) return state;
      return { ...state, draft: { ...state.draft, tipoDespesa: action.tipoDespesa } };

    default:
      return state;
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────
export interface WizardGuards {
  canAdvanceDados: (isReforma: boolean) => boolean;
  canAdvancePagamento: () => boolean;
  canSaveBasket: () => boolean;
}

export interface WizardTotals {
  totalFonteCents: number;
  sobraCents: number;
}

export function useNovaDespesaWizard(initial?: WizardMode | Partial<WizardState>) {
  const [state, dispatch] = useReducer(novaDespesaReducer, initial, (arg) => {
    if (typeof arg === 'string') return makeInitialWizardState(arg);
    return { ...makeInitialWizardState(arg?.mode ?? 'PLANEJAR'), ...(arg ?? {}) };
  });

  const guards = useMemo<WizardGuards>(
    () => ({
      canAdvanceDados: (isReforma: boolean) => canAdvanceDados(state, { isReforma }),
      canAdvancePagamento: () => canAdvancePagamento(state),
      canSaveBasket: () => canSaveBasket(state),
    }),
    [state],
  );

  const totals = useMemo<WizardTotals>(
    () => ({ totalFonteCents: totalFonteCents(state.draft), sobraCents: sobraCents(state) }),
    [state],
  );

  return { state, dispatch, guards, totals };
}
