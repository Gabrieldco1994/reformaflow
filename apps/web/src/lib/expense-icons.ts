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
  HelpCircle,
  LucideIcon,
} from 'lucide-react';
import { ExpenseType } from '@reformaflow/domain';

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
    Icon: Smile,
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
    Icon: HelpCircle,
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

export function getExpenseIcon(type: string | ExpenseType): ExpenseIconConfig {
  return EXPENSE_ICON_MAP[type as ExpenseType] || EXPENSE_ICON_MAP[ExpenseType.OUTROS];
}
