import {
  Hammer,
  Package,
  Zap,
  Lightbulb,
  Square,
  Wrench,
  PanelTop,
  Users,
  DollarSign,
  Home,
  UtensilsCrossed,
  Car,
  Heart,
  BookOpen,
  Smile,
  Sparkles,
  Dog,
  ShoppingCart,
  Brush,
  HandshakeIcon,
  TrendingUp,
  Shield,
  AlertCircle,
  Inbox,
  Send,
  CreditCard,
  FileText,
  BarChart3,
  Clock,
  Landmark,
  Cable,
  TrendingDown,
  Archive,
  Banknote,
  Laptop,
  Award,
  PiggyBank,
  Bitcoin,
  Undo2,
  Wallet,
  ArrowLeftRight,
  ReceiptText,
  FileCheck,
  Tag,
  Gift,
  CircleDollarSign,
  LucideIcon,
} from 'lucide-react';
import { ExpenseType, ReceiptType } from '@reformaflow/domain';

export interface ExpenseIconConfig {
  Icon: LucideIcon;
  color: string;
  bgColor: string;
}

// ponytail: mapping tipos de despesa → ícone + cor. Adicionar novos tipos = adicionar entrada aqui.
export const EXPENSE_ICON_MAP: Record<ExpenseType, ExpenseIconConfig> = {
  // Reforma/Construção
  [ExpenseType.MATERIAL_CONSTRUCAO]: {
    Icon: Hammer,
    color: 'text-orange-600',
    bgColor: 'bg-orange-50',
  },
  [ExpenseType.ELETRODOMESTICO]: {
    Icon: Package,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
  },
  [ExpenseType.REVESTIMENTO]: {
    Icon: Square,
    color: 'text-slate-600',
    bgColor: 'bg-slate-50',
  },
  [ExpenseType.ILUMINACAO]: {
    Icon: Lightbulb,
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-50',
  },
  [ExpenseType.MARMORE]: {
    Icon: BarChart3,
    color: 'text-gray-600',
    bgColor: 'bg-gray-50',
  },
  [ExpenseType.VIDRACARIA_SERRALHERIA]: {
    Icon: PanelTop,
    color: 'text-cyan-600',
    bgColor: 'bg-cyan-50',
  },
  [ExpenseType.METAL_CERAMICA]: {
    Icon: Package,
    color: 'text-amber-600',
    bgColor: 'bg-amber-50',
  },
  [ExpenseType.MARCENARIA]: {
    Icon: Wrench,
    color: 'text-amber-700',
    bgColor: 'bg-amber-50',
  },
  [ExpenseType.MAO_DE_OBRA]: {
    Icon: Users,
    color: 'text-indigo-600',
    bgColor: 'bg-indigo-50',
  },

  // Compra (Imóvel)
  [ExpenseType.ENTRADA]: {
    Icon: DollarSign,
    color: 'text-green-600',
    bgColor: 'bg-green-50',
  },
  [ExpenseType.FINANCIAMENTO]: {
    Icon: TrendingUp,
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
  },
  [ExpenseType.DOCUMENTACAO]: {
    Icon: FileText,
    color: 'text-red-600',
    bgColor: 'bg-red-50',
  },
  [ExpenseType.CARTORIO]: {
    Icon: Landmark,
    color: 'text-slate-700',
    bgColor: 'bg-slate-50',
  },
  [ExpenseType.IMPOSTO]: {
    Icon: TrendingDown,
    color: 'text-red-600',
    bgColor: 'bg-red-50',
  },
  [ExpenseType.SEGURO_COMPRA]: {
    Icon: Shield,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
  },
  [ExpenseType.VISTORIA]: {
    Icon: AlertCircle,
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-50',
  },
  [ExpenseType.MUDANCA]: {
    Icon: Archive,
    color: 'text-orange-600',
    bgColor: 'bg-orange-50',
  },

  // Pessoal (Casa, Carro, Geral)
  [ExpenseType.MORADIA]: {
    Icon: Home,
    color: 'text-red-600',
    bgColor: 'bg-red-50',
  },
  [ExpenseType.ALIMENTACAO]: {
    Icon: UtensilsCrossed,
    color: 'text-amber-600',
    bgColor: 'bg-amber-50',
  },
  [ExpenseType.TRANSPORTE]: {
    Icon: Car,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
  },
  [ExpenseType.SAUDE]: {
    Icon: Heart,
    color: 'text-rose-600',
    bgColor: 'bg-rose-50',
  },
  [ExpenseType.EDUCACAO]: {
    Icon: BookOpen,
    color: 'text-indigo-600',
    bgColor: 'bg-indigo-50',
  },
  [ExpenseType.LAZER]: {
    Icon: Smile,
    color: 'text-pink-600',
    bgColor: 'bg-pink-50',
  },
  [ExpenseType.BELEZA]: {
    Icon: Sparkles,
    color: 'text-fuchsia-600',
    bgColor: 'bg-fuchsia-50',
  },
  [ExpenseType.PETS]: {
    Icon: Dog,
    color: 'text-amber-600',
    bgColor: 'bg-amber-50',
  },
  [ExpenseType.SUPERMERCADO]: {
    Icon: ShoppingCart,
    color: 'text-green-600',
    bgColor: 'bg-green-50',
  },
  [ExpenseType.FAXINEIRA]: {
    Icon: Brush,
    color: 'text-slate-600',
    bgColor: 'bg-slate-50',
  },
  [ExpenseType.AJUDA]: {
    Icon: HandshakeIcon,
    color: 'text-cyan-600',
    bgColor: 'bg-cyan-50',
  },
  [ExpenseType.REEMBOLSO_MEDICO]: {
    Icon: Heart,
    color: 'text-green-600',
    bgColor: 'bg-green-50',
  },
  [ExpenseType.ACADEMIA]: {
    Icon: Zap,
    color: 'text-orange-600',
    bgColor: 'bg-orange-50',
  },
  [ExpenseType.ESTACIONAMENTO]: {
    Icon: Car,
    color: 'text-gray-600',
    bgColor: 'bg-gray-50',
  },
  [ExpenseType.GASOLINA]: {
    Icon: Zap,
    color: 'text-red-600',
    bgColor: 'bg-red-50',
  },
  [ExpenseType.LAVAGEM]: {
    Icon: Brush,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
  },
  [ExpenseType.ASSINATURAS]: {
    Icon: CreditCard,
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
  },
  [ExpenseType.INVESTIMENTOS]: {
    Icon: TrendingUp,
    color: 'text-green-600',
    bgColor: 'bg-green-50',
  },
  [ExpenseType.SEGUROS_PESSOAIS]: {
    Icon: Shield,
    color: 'text-indigo-600',
    bgColor: 'bg-indigo-50',
  },
  [ExpenseType.IMPREVISTOS]: {
    Icon: AlertCircle,
    color: 'text-red-600',
    bgColor: 'bg-red-50',
  },
  [ExpenseType.OUTROS]: {
    Icon: Tag,
    color: 'text-slate-600',
    bgColor: 'bg-slate-50',
  },

  // Movimentações internas
  [ExpenseType.MOVIMENTACAO_INTERNA]: {
    Icon: Send,
    color: 'text-slate-600',
    bgColor: 'bg-slate-50',
  },

  // Consolidado financeiro (Conta/Faturas)
  [ExpenseType.CARTAO_CREDITO]: {
    Icon: CreditCard,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
  },
  [ExpenseType.PIX_ENVIADO]: {
    Icon: Send,
    color: 'text-orange-600',
    bgColor: 'bg-orange-50',
  },
  [ExpenseType.COMPRAS_VAREJO]: {
    Icon: ShoppingCart,
    color: 'text-green-600',
    bgColor: 'bg-green-50',
  },
  [ExpenseType.COMPRAS_DEBITO]: {
    Icon: CreditCard,
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
  },
  [ExpenseType.OBRA_REFORMA]: {
    Icon: Hammer,
    color: 'text-orange-600',
    bgColor: 'bg-orange-50',
  },
  [ExpenseType.CONTAS_UTILIDADES]: {
    Icon: Cable,
    color: 'text-amber-600',
    bgColor: 'bg-amber-50',
  },
  [ExpenseType.TELEFONE_INTERNET]: {
    Icon: Cable,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
  },
  [ExpenseType.IMPOSTOS_IOF]: {
    Icon: TrendingDown,
    color: 'text-red-600',
    bgColor: 'bg-red-50',
  },
  [ExpenseType.IMPOSTOS_TAXAS]: {
    Icon: TrendingDown,
    color: 'text-red-600',
    bgColor: 'bg-red-50',
  },
  [ExpenseType.TARIFAS_BANCARIAS]: {
    Icon: Landmark,
    color: 'text-slate-600',
    bgColor: 'bg-slate-50',
  },
  [ExpenseType.ESTORNOS_AJUSTES]: {
    Icon: BarChart3,
    color: 'text-slate-600',
    bgColor: 'bg-slate-50',
  },
  [ExpenseType.PAGAMENTO_BOLETO]: {
    Icon: FileText,
    color: 'text-slate-600',
    bgColor: 'bg-slate-50',
  },
  [ExpenseType.TRANSFERENCIA_TED]: {
    Icon: Send,
    color: 'text-cyan-600',
    bgColor: 'bg-cyan-50',
  },
  [ExpenseType.PAGAMENTO_CASA]: {
    Icon: Home,
    color: 'text-emerald-600',
    bgColor: 'bg-emerald-50',
  },
};

// Categorias legadas/importadas que NÃO são membros do enum (vêm de extrato/importação).
// Mapeadas à mão para não caírem no ícone genérico "Outros". Chave em MAIÚSCULO.
const EXPENSE_ICON_ALIASES: Record<string, ExpenseIconConfig> = {
  TRANSFERENCIA: { Icon: ArrowLeftRight, color: 'text-cyan-600', bgColor: 'bg-cyan-50' },
  PAGAMENTO_FATURA_CARTAO: { Icon: CreditCard, color: 'text-blue-600', bgColor: 'bg-blue-50' },
};

export function getExpenseIcon(type: string | ExpenseType): ExpenseIconConfig {
  const key = (type ?? '').toString().toUpperCase();
  return (
    EXPENSE_ICON_MAP[key as ExpenseType] ||
    EXPENSE_ICON_ALIASES[key] ||
    EXPENSE_ICON_MAP[ExpenseType.OUTROS]
  );
}

// ponytail: mapping tipos de recebimento → ícone + cor. Verdes/emerald p/ renda,
// slate p/ neutros (resgate/transferência/alocação). Novos tipos = nova entrada.
export const RECEIPT_ICON_MAP: Record<ReceiptType, ExpenseIconConfig> = {
  // Trabalho / renda salarial
  [ReceiptType.SALARIO]: { Icon: Banknote, color: 'text-green-600', bgColor: 'bg-green-50' },
  [ReceiptType.ADIANTAMENTO_SALARIO]: { Icon: Banknote, color: 'text-green-600', bgColor: 'bg-green-50' },
  [ReceiptType.DECIMO_TERCEIRO]: { Icon: Banknote, color: 'text-green-600', bgColor: 'bg-green-50' },
  [ReceiptType.FERIAS]: { Icon: Banknote, color: 'text-green-600', bgColor: 'bg-green-50' },
  [ReceiptType.FREELANCE]: { Icon: Laptop, color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  [ReceiptType.BONUS]: { Icon: Award, color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  [ReceiptType.COMISSAO]: { Icon: Award, color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  [ReceiptType.PENSAO]: { Icon: Landmark, color: 'text-green-600', bgColor: 'bg-green-50' },

  // Investimentos / rendimentos
  [ReceiptType.DIVIDENDOS]: { Icon: TrendingUp, color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  [ReceiptType.ACAO]: { Icon: TrendingUp, color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  [ReceiptType.VENDA_ACAO]: { Icon: TrendingUp, color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  [ReceiptType.FII]: { Icon: TrendingUp, color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  [ReceiptType.JUROS_RENDA_FIXA]: { Icon: PiggyBank, color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  [ReceiptType.POUPANCA]: { Icon: PiggyBank, color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  [ReceiptType.CRIPTO]: { Icon: Bitcoin, color: 'text-amber-600', bgColor: 'bg-amber-50' },

  // Outras rendas
  [ReceiptType.ALUGUEL]: { Icon: Home, color: 'text-green-600', bgColor: 'bg-green-50' },
  [ReceiptType.REEMBOLSO]: { Icon: ReceiptText, color: 'text-teal-600', bgColor: 'bg-teal-50' },
  [ReceiptType.RESTITUICAO_IR]: { Icon: FileCheck, color: 'text-green-600', bgColor: 'bg-green-50' },
  [ReceiptType.VENDA_BEM]: { Icon: Tag, color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  [ReceiptType.PRESENTE]: { Icon: Gift, color: 'text-pink-600', bgColor: 'bg-pink-50' },
  [ReceiptType.PAGAMENTO]: { Icon: CircleDollarSign, color: 'text-green-600', bgColor: 'bg-green-50' },
  [ReceiptType.PIX_RECEBIDO]: { Icon: CircleDollarSign, color: 'text-green-600', bgColor: 'bg-green-50' },

  // Neutros (movimentação própria / alocação — não é renda nova)
  [ReceiptType.RESGATE]: { Icon: Undo2, color: 'text-slate-600', bgColor: 'bg-slate-50' },
  [ReceiptType.TRANSFERENCIA_PROPRIA]: { Icon: ArrowLeftRight, color: 'text-slate-600', bgColor: 'bg-slate-50' },
  [ReceiptType.ALOCACAO_ORCAMENTO]: { Icon: Wallet, color: 'text-slate-600', bgColor: 'bg-slate-50' },
  [ReceiptType.ORCAMENTO_INICIAL]: { Icon: Wallet, color: 'text-slate-600', bgColor: 'bg-slate-50' },

  [ReceiptType.OUTROS]: { Icon: CircleDollarSign, color: 'text-slate-600', bgColor: 'bg-slate-50' },
};

// Tipos de recebimento legados/importados (não são membros do enum ReceiptType).
const RECEIPT_ICON_ALIASES: Record<string, ExpenseIconConfig> = {
  RENDIMENTO: { Icon: TrendingUp, color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  TRANSFERENCIA: { Icon: ArrowLeftRight, color: 'text-slate-600', bgColor: 'bg-slate-50' },
};

/**
 * Ícone semântico do tipo de recebimento. Aceita o enum (maiúsculo) ou o valor
 * já normalizado pela Visão Conta (minúsculo, sem acento) — daí o toUpperCase.
 */
export function getReceiptIcon(type: string | ReceiptType): ExpenseIconConfig {
  const key = (type ?? '').toString().toUpperCase() as ReceiptType;
  return RECEIPT_ICON_MAP[key] || RECEIPT_ICON_ALIASES[key] || RECEIPT_ICON_MAP[ReceiptType.OUTROS];
}
