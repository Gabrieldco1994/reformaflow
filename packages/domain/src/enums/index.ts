export enum UserRole {
  OWNER = 'OWNER',
  COLLABORATOR = 'COLLABORATOR',
  VIEWER = 'VIEWER',
}

// ─── Recebimentos ───────────────────────────────────────────

export enum ReceiptType {
  PAGAMENTO = 'PAGAMENTO',
  BONUS = 'BONUS',
  VENDA_ACAO = 'VENDA_ACAO',
  ORCAMENTO_INICIAL = 'ORCAMENTO_INICIAL',
}

export enum ReceiptStatus {
  PREVISTO = 'PREVISTO',
  EM_CAIXA = 'EM_CAIXA',
}

// ─── Despesas ───────────────────────────────────────────────

export enum ExpenseType {
  MATERIAL_CONSTRUCAO = 'MATERIAL_CONSTRUCAO',
  ELETRODOMESTICO = 'ELETRODOMESTICO',
  REVESTIMENTO = 'REVESTIMENTO',
  ILUMINACAO = 'ILUMINACAO',
  MARMORE = 'MARMORE',
  VIDRACARIA_SERRALHERIA = 'VIDRACARIA_SERRALHERIA',
  METAL_CERAMICA = 'METAL_CERAMICA',
  MARCENARIA = 'MARCENARIA',
  MAO_DE_OBRA = 'MAO_DE_OBRA',
}

export enum LaborCategory {
  EMPREITEIRO = 'EMPREITEIRO',
  INSTALADOR_PISO = 'INSTALADOR_PISO',
  INSTALADOR_MARMORE = 'INSTALADOR_MARMORE',
  PINTOR = 'PINTOR',
  ELETRICISTA = 'ELETRICISTA',
  VIDRACEIRO = 'VIDRACEIRO',
  SERRALHEIRO = 'SERRALHEIRO',
  MARCENEIRO = 'MARCENEIRO',
}

export enum PaymentForm {
  A_VISTA = 'A_VISTA',
  PARCELADO = 'PARCELADO',
  QUINZENAL = 'QUINZENAL',
}

export enum ExpenseStatus {
  PLANEJADO = 'PLANEJADO',
  PAGO = 'PAGO',
}

// ─── Fluxo de Caixa ────────────────────────────────────────

export enum CashFlowType {
  RECEBIMENTO = 'RECEBIMENTO',
  DESPESA = 'DESPESA',
}

export enum CashFlowStatus {
  PAGO = 'PAGO',
  PLANEJADO = 'PLANEJADO',
  PREVISTO = 'PREVISTO',
  EM_CAIXA = 'EM_CAIXA',
}

// ─── Labels para exibição ───────────────────────────────────

export const ReceiptTypeLabels: Record<ReceiptType, string> = {
  [ReceiptType.PAGAMENTO]: 'Pagamento',
  [ReceiptType.BONUS]: 'Bônus',
  [ReceiptType.VENDA_ACAO]: 'Venda de Ação',
  [ReceiptType.ORCAMENTO_INICIAL]: 'Orçamento Inicial',
};

export const ExpenseTypeLabels: Record<ExpenseType, string> = {
  [ExpenseType.MATERIAL_CONSTRUCAO]: 'Material p/ Construção',
  [ExpenseType.ELETRODOMESTICO]: 'Eletrodoméstico',
  [ExpenseType.REVESTIMENTO]: 'Revestimento',
  [ExpenseType.ILUMINACAO]: 'Iluminação',
  [ExpenseType.MARMORE]: 'Mármore',
  [ExpenseType.VIDRACARIA_SERRALHERIA]: 'Vidraçaria & Serralheria',
  [ExpenseType.METAL_CERAMICA]: 'Metal & Cerâmica',
  [ExpenseType.MARCENARIA]: 'Marcenaria',
  [ExpenseType.MAO_DE_OBRA]: 'Mão de Obra',
};

export const LaborCategoryLabels: Record<LaborCategory, string> = {
  [LaborCategory.EMPREITEIRO]: 'Empreiteiro',
  [LaborCategory.INSTALADOR_PISO]: 'Instalador de Piso',
  [LaborCategory.INSTALADOR_MARMORE]: 'Instalador de Mármore',
  [LaborCategory.PINTOR]: 'Pintor',
  [LaborCategory.ELETRICISTA]: 'Eletricista',
  [LaborCategory.VIDRACEIRO]: 'Vidraceiro',
  [LaborCategory.SERRALHEIRO]: 'Serralheiro',
  [LaborCategory.MARCENEIRO]: 'Marceneiro',
};

export const PaymentFormLabels: Record<PaymentForm, string> = {
  [PaymentForm.A_VISTA]: 'À Vista',
  [PaymentForm.PARCELADO]: 'Parcelado',
  [PaymentForm.QUINZENAL]: 'Quinzenal',
};

export const CashFlowStatusLabels: Record<CashFlowStatus, string> = {
  [CashFlowStatus.PAGO]: 'Pago',
  [CashFlowStatus.PLANEJADO]: 'Planejado',
  [CashFlowStatus.PREVISTO]: 'Previsto',
  [CashFlowStatus.EM_CAIXA]: 'Em Caixa',
};

export const ReceiptStatusLabels: Record<ReceiptStatus, string> = {
  [ReceiptStatus.PREVISTO]: 'Previsto',
  [ReceiptStatus.EM_CAIXA]: 'Em Caixa',
};

export const ExpenseStatusLabels: Record<ExpenseStatus, string> = {
  [ExpenseStatus.PLANEJADO]: 'Planejado',
  [ExpenseStatus.PAGO]: 'Pago',
};
