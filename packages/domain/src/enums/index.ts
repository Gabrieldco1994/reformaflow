// ─── Tipos de Projeto ───────────────────────────────────────

export enum ProjectType {
  REFORMA = 'REFORMA',
  COMPRA = 'COMPRA',
  CASA = 'CASA',
  CARRO = 'CARRO',
}

export const ProjectTypeLabels: Record<ProjectType, string> = {
  [ProjectType.REFORMA]: 'Reforma',
  [ProjectType.COMPRA]: 'Compra',
  [ProjectType.CASA]: 'Casa',
  [ProjectType.CARRO]: 'Carro',
};

export const ProjectTypeIcons: Record<ProjectType, string> = {
  [ProjectType.REFORMA]: '🏗️',
  [ProjectType.COMPRA]: '🏠',
  [ProjectType.CASA]: '🏡',
  [ProjectType.CARRO]: '🚗',
};

export const ProjectTypeDescriptions: Record<ProjectType, string> = {
  [ProjectType.REFORMA]: 'Controle financeiro e visual de reformas',
  [ProjectType.COMPRA]: 'Acompanhe compras grandes (casa, carro, etc.)',
  [ProjectType.CASA]: 'Gerencie contas, manutenções e lembretes da casa',
  [ProjectType.CARRO]: 'Controle manutenções, custos e lembretes do carro',
};

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
  // COMPRA-specific types
  ENTRADA = 'ENTRADA',
  FINANCIAMENTO = 'FINANCIAMENTO',
  DOCUMENTACAO = 'DOCUMENTACAO',
  CARTORIO = 'CARTORIO',
  IMPOSTO = 'IMPOSTO',
  SEGURO_COMPRA = 'SEGURO_COMPRA',
  VISTORIA = 'VISTORIA',
  MUDANCA = 'MUDANCA',
  OUTROS = 'OUTROS',
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
  [ExpenseType.ENTRADA]: 'Entrada',
  [ExpenseType.FINANCIAMENTO]: 'Financiamento',
  [ExpenseType.DOCUMENTACAO]: 'Documentação',
  [ExpenseType.CARTORIO]: 'Cartório',
  [ExpenseType.IMPOSTO]: 'Imposto',
  [ExpenseType.SEGURO_COMPRA]: 'Seguro',
  [ExpenseType.VISTORIA]: 'Vistoria',
  [ExpenseType.MUDANCA]: 'Mudança',
  [ExpenseType.OUTROS]: 'Outros',
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

// ─── Contas Recorrentes ─────────────────────────────────────

export enum BillCategory {
  LUZ = 'LUZ',
  AGUA = 'AGUA',
  INTERNET = 'INTERNET',
  IPTU = 'IPTU',
  CONDOMINIO = 'CONDOMINIO',
  SEGURO = 'SEGURO',
  GAS = 'GAS',
  TELEFONE = 'TELEFONE',
  STREAMING = 'STREAMING',
  OUTRO = 'OUTRO',
}

export const BillCategoryLabels: Record<BillCategory, string> = {
  [BillCategory.LUZ]: 'Luz',
  [BillCategory.AGUA]: 'Água',
  [BillCategory.INTERNET]: 'Internet',
  [BillCategory.IPTU]: 'IPTU',
  [BillCategory.CONDOMINIO]: 'Condomínio',
  [BillCategory.SEGURO]: 'Seguro',
  [BillCategory.GAS]: 'Gás',
  [BillCategory.TELEFONE]: 'Telefone',
  [BillCategory.STREAMING]: 'Streaming',
  [BillCategory.OUTRO]: 'Outro',
};

export enum BillFrequency {
  MENSAL = 'MENSAL',
  BIMESTRAL = 'BIMESTRAL',
  TRIMESTRAL = 'TRIMESTRAL',
  SEMESTRAL = 'SEMESTRAL',
  ANUAL = 'ANUAL',
}

export const BillFrequencyLabels: Record<BillFrequency, string> = {
  [BillFrequency.MENSAL]: 'Mensal',
  [BillFrequency.BIMESTRAL]: 'Bimestral',
  [BillFrequency.TRIMESTRAL]: 'Trimestral',
  [BillFrequency.SEMESTRAL]: 'Semestral',
  [BillFrequency.ANUAL]: 'Anual',
};

export enum BillStatus {
  ATIVO = 'ATIVO',
  PAUSADO = 'PAUSADO',
}

export const BillStatusLabels: Record<BillStatus, string> = {
  [BillStatus.ATIVO]: 'Ativo',
  [BillStatus.PAUSADO]: 'Pausado',
};

// ─── Manutenções ────────────────────────────────────────────

export enum HouseMaintenanceType {
  PINTURA = 'PINTURA',
  IMPERMEABILIZACAO = 'IMPERMEABILIZACAO',
  DEDETIZACAO = 'DEDETIZACAO',
  LIMPEZA_CAIXA = 'LIMPEZA_CAIXA',
  REVISAO_ELETRICA = 'REVISAO_ELETRICA',
  REVISAO_HIDRAULICA = 'REVISAO_HIDRAULICA',
  OUTRO = 'OUTRO',
}

export const HouseMaintenanceTypeLabels: Record<HouseMaintenanceType, string> = {
  [HouseMaintenanceType.PINTURA]: 'Pintura',
  [HouseMaintenanceType.IMPERMEABILIZACAO]: 'Impermeabilização',
  [HouseMaintenanceType.DEDETIZACAO]: 'Dedetização',
  [HouseMaintenanceType.LIMPEZA_CAIXA]: 'Limpeza de Caixa d\'Água',
  [HouseMaintenanceType.REVISAO_ELETRICA]: 'Revisão Elétrica',
  [HouseMaintenanceType.REVISAO_HIDRAULICA]: 'Revisão Hidráulica',
  [HouseMaintenanceType.OUTRO]: 'Outro',
};

export enum CarMaintenanceType {
  TROCA_OLEO = 'TROCA_OLEO',
  FILTRO_AR = 'FILTRO_AR',
  FILTRO_OLEO = 'FILTRO_OLEO',
  FILTRO_COMBUSTIVEL = 'FILTRO_COMBUSTIVEL',
  PNEUS = 'PNEUS',
  ALINHAMENTO = 'ALINHAMENTO',
  BALANCEAMENTO = 'BALANCEAMENTO',
  REVISAO = 'REVISAO',
  FREIOS = 'FREIOS',
  CORREIA = 'CORREIA',
  OUTRO = 'OUTRO',
}

export const CarMaintenanceTypeLabels: Record<CarMaintenanceType, string> = {
  [CarMaintenanceType.TROCA_OLEO]: 'Troca de Óleo',
  [CarMaintenanceType.FILTRO_AR]: 'Filtro de Ar',
  [CarMaintenanceType.FILTRO_OLEO]: 'Filtro de Óleo',
  [CarMaintenanceType.FILTRO_COMBUSTIVEL]: 'Filtro de Combustível',
  [CarMaintenanceType.PNEUS]: 'Pneus',
  [CarMaintenanceType.ALINHAMENTO]: 'Alinhamento',
  [CarMaintenanceType.BALANCEAMENTO]: 'Balanceamento',
  [CarMaintenanceType.REVISAO]: 'Revisão Completa',
  [CarMaintenanceType.FREIOS]: 'Freios',
  [CarMaintenanceType.CORREIA]: 'Correia Dentada',
  [CarMaintenanceType.OUTRO]: 'Outro',
};

// ─── Lembretes ──────────────────────────────────────────────

export enum ReminderRecurrence {
  UNICA = 'UNICA',
  DIARIA = 'DIARIA',
  SEMANAL = 'SEMANAL',
  MENSAL = 'MENSAL',
  ANUAL = 'ANUAL',
}

export const ReminderRecurrenceLabels: Record<ReminderRecurrence, string> = {
  [ReminderRecurrence.UNICA]: 'Única',
  [ReminderRecurrence.DIARIA]: 'Diária',
  [ReminderRecurrence.SEMANAL]: 'Semanal',
  [ReminderRecurrence.MENSAL]: 'Mensal',
  [ReminderRecurrence.ANUAL]: 'Anual',
};

export enum ReminderStatus {
  PENDENTE = 'PENDENTE',
  CONCLUIDO = 'CONCLUIDO',
  ADIADO = 'ADIADO',
}

export const ReminderStatusLabels: Record<ReminderStatus, string> = {
  [ReminderStatus.PENDENTE]: 'Pendente',
  [ReminderStatus.CONCLUIDO]: 'Concluído',
  [ReminderStatus.ADIADO]: 'Adiado',
};

export enum ReminderPriority {
  BAIXA = 'BAIXA',
  MEDIA = 'MEDIA',
  ALTA = 'ALTA',
  URGENTE = 'URGENTE',
}

export const ReminderPriorityLabels: Record<ReminderPriority, string> = {
  [ReminderPriority.BAIXA]: 'Baixa',
  [ReminderPriority.MEDIA]: 'Média',
  [ReminderPriority.ALTA]: 'Alta',
  [ReminderPriority.URGENTE]: 'Urgente',
};
