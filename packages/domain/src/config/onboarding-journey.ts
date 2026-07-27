import { ProjectType } from '../enums';

/**
 * CATÁLOGO DA JORNADA DE ONBOARDING — fonte de verdade compartilhada entre a
 * API (que persiste os overrides do admin) e o web (que renderiza as telas).
 *
 * Por que aqui e não em `apps/web/.../steps-config.ts`: aquele arquivo mapeia
 * `key → Componente React`, então a API não pode importá-lo. O catálogo abaixo
 * é só dado (sem React), então os dois lados compartilham a MESMA definição de
 * quais telas existem, em que ordem nascem e com que texto padrão.
 *
 * Divisão de responsabilidade:
 * - Este arquivo: quais telas existem + defaults (ordem, texto, pulável).
 * - Banco (`OnboardingJourneyStep`): os overrides que o admin salvou.
 * - `steps-config.ts` (web): `key → Componente`. Nada de ordem/texto lá.
 *
 * Uma tela sem entrada no banco cai no default daqui — o admin nunca precisa
 * salvar nada para o onboarding funcionar, e uma tela nova nasce visível.
 */

/** Telas que o admin NÃO pode reordenar nem desligar (bookends do fluxo). */
export const ONBOARDING_FIXED_STEPS = ['project', 'done'] as const;

// ─── Tipos de runtime do passo `funding` (transitório — não persistir) ───────

export type FundingKind = 'bankAccount' | 'creditCard';
export type FundingOrigin = 'existing' | 'created';

export interface FundingSourceRef {
  kind: FundingKind;
  id: string;
  ownerProjectId: string;
  origin: FundingOrigin;
}

/** Estado transitório do passo `funding` — vive só no ciclo de vida do wizard. */
export interface OnboardingFunding {
  bankAccount: FundingSourceRef | null;
  creditCard: FundingSourceRef | null;
}

export interface JourneyStepDef {
  /** Id estável — casa com a chave do componente em `steps-config.ts`. */
  key: string;
  /** Rótulo curto usado na régua de progresso e no painel do admin. */
  label: string;
  /** Texto de apoio da tela (o admin pode sobrescrever). */
  defaultSubtitle: string;
  /**
   * `false` = a tela só aparece sob condição extra do wizard (ex.: a Maria só
   * existe se a despesa foi criada). O admin ainda pode desligá-la, mas ligá-la
   * não burla a condição.
   */
  alwaysAvailable: boolean;
  /** Default de "pode pular". O admin pode tornar a tela obrigatória. */
  skippableByDefault: boolean;
}

/**
 * Jornada padrão por tipo de projeto, na ordem em que nasce.
 * Espelha o `ANCHOR_STEPS` original + os passos dinâmicos (Maria/Feedback),
 * que agora também são configuráveis.
 */
export const ONBOARDING_JOURNEY_DEFAULTS: Record<ProjectType, JourneyStepDef[]> = {
  [ProjectType.PESSOAL]: [
    {
      key: 'funding',
      label: 'Contas & cartões',
      defaultSubtitle:
        'Sem conta ou cartão, o Caixa mostra só o fluxo. Dá pra definir depois em Contas Bancárias e Cartões.',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'expense',
      label: 'Despesa',
      defaultSubtitle: 'Lance um gasto de hoje para o app começar a te mostrar algo real.',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'import',
      label: 'Importar',
      defaultSubtitle: 'Traga seu extrato ou fatura de uma vez em vez de digitar tudo.',
      alwaysAvailable: true,
      skippableByDefault: true,
      // ponytail: desabilitar este passo via API para unificar Despesa + Importar (via admin UI toggle)
    },
    {
      key: 'expense-import',
      label: 'Despesa + Importar',
      defaultSubtitle: 'Lance um gasto ou importe múltiplos em uma única tela.',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'receipt',
      label: 'Recebimento',
      defaultSubtitle: 'Cadastre o que entra para a sobra do mês fazer sentido.',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'maria-insight',
      label: 'Maria',
      defaultSubtitle: 'Pergunte à Maria sobre esse gasto.',
      alwaysAvailable: false,
      skippableByDefault: true,
    },
    {
      key: 'feedback',
      label: 'Feedback',
      defaultSubtitle: 'Como foi começar por aqui?',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
  ],
  [ProjectType.REFORMA]: [
    {
      key: 'expense',
      label: 'Despesa',
      defaultSubtitle: 'Lance o primeiro gasto da obra.',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'feedback',
      label: 'Feedback',
      defaultSubtitle: 'Como foi começar por aqui?',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
  ],
  [ProjectType.COMPRA]: [
    {
      key: 'expense',
      label: 'Despesa',
      defaultSubtitle: 'Lance o primeiro gasto dessa compra.',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'feedback',
      label: 'Feedback',
      defaultSubtitle: 'Como foi começar por aqui?',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
  ],
  [ProjectType.CASA]: [
    {
      key: 'bill',
      label: 'Conta',
      defaultSubtitle: 'Cadastre uma conta que se repete todo mês (água, luz, condomínio…).',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'feedback',
      label: 'Feedback',
      defaultSubtitle: 'Como foi começar por aqui?',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
  ],
  [ProjectType.CARRO]: [
    {
      key: 'car',
      label: 'Veículo',
      defaultSubtitle: 'Dados do veículo (placa, modelo, ano…).',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'feedback',
      label: 'Feedback',
      defaultSubtitle: 'Como foi começar por aqui?',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
  ],
  [ProjectType.PLANTAS]: [
    {
      key: 'plant',
      label: 'Planta',
      defaultSubtitle: 'Cadastre sua primeira planta (nome, espécie, ambiente…).',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'feedback',
      label: 'Feedback',
      defaultSubtitle: 'Como foi começar por aqui?',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
  ],
};

/** Uma tela da jornada já com os overrides do admin aplicados. */
export interface ResolvedJourneyStep {
  key: string;
  label: string;
  subtitle: string;
  enabled: boolean;
  /** `false` = tela obrigatória: o wizard não oferece "pular". */
  skippable: boolean;
  alwaysAvailable: boolean;
}

/** Override vindo do banco. Campos ausentes caem no default do catálogo. */
export interface JourneyStepOverride {
  stepKey: string;
  order?: number | null;
  enabled?: boolean | null;
  skippable?: boolean | null;
  label?: string | null;
  subtitle?: string | null;
}

/**
 * Aplica os overrides do admin sobre o catálogo padrão.
 *
 * Regras (as duas primeiras existem para o onboarding NUNCA quebrar por causa
 * de configuração — ele é a primeira experiência do usuário no produto):
 * 1. Tela sem override = default, visível. Config vazia ⇒ jornada padrão.
 * 2. Override órfão (tela que não existe mais no catálogo) é IGNORADO, não
 *    quebra — o admin pode ter salvo antes de um deploy remover a tela.
 * 3. A ordem é a do `order` salvo; empate ou ausência cai na ordem do catálogo.
 */
export function resolveJourney(
  projectType: ProjectType,
  overrides: JourneyStepOverride[] = [],
): ResolvedJourneyStep[] {
  const defaults = ONBOARDING_JOURNEY_DEFAULTS[projectType] ?? [];
  const byKey = new Map(overrides.map((o) => [o.stepKey, o]));

  return defaults
    .map((def, index) => {
      const override = byKey.get(def.key);
      return {
        step: {
          key: def.key,
          label: override?.label?.trim() || def.label,
          subtitle: override?.subtitle?.trim() || def.defaultSubtitle,
          enabled: override?.enabled ?? true,
          skippable: override?.skippable ?? def.skippableByDefault,
          alwaysAvailable: def.alwaysAvailable,
        },
        order: override?.order ?? index,
        index,
      };
    })
    .sort((a, b) => (a.order - b.order) || (a.index - b.index))
    .map((entry) => entry.step);
}
