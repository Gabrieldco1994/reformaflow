// ─── Tipos de Projeto ───────────────────────────────────────

export enum ProjectType {
  REFORMA = 'REFORMA',
  COMPRA = 'COMPRA',
  CASA = 'CASA',
  CARRO = 'CARRO',
  PESSOAL = 'PESSOAL',
}

export const ProjectTypeLabels: Record<ProjectType, string> = {
  [ProjectType.REFORMA]: 'Reforma',
  [ProjectType.COMPRA]: 'Compra',
  [ProjectType.CASA]: 'Casa',
  [ProjectType.CARRO]: 'Carro',
  [ProjectType.PESSOAL]: 'Pessoal',
};

export const ProjectTypeIcons: Record<ProjectType, string> = {
  [ProjectType.REFORMA]: '🏗️',
  [ProjectType.COMPRA]: '🏠',
  [ProjectType.CASA]: '🏡',
  [ProjectType.CARRO]: '🚗',
  [ProjectType.PESSOAL]: '💰',
};

export const ProjectTypeDescriptions: Record<ProjectType, string> = {
  [ProjectType.REFORMA]: 'Controle financeiro e visual de reformas',
  [ProjectType.COMPRA]: 'Acompanhe compras grandes (casa, carro, etc.)',
  [ProjectType.CASA]: 'Gerencie contas, manutenções e lembretes da casa',
  [ProjectType.CARRO]: 'Controle manutenções, custos e lembretes do carro',
  [ProjectType.PESSOAL]: 'Controle de despesas e recebimentos pessoais',
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
  SALARIO = 'SALARIO',
  ADIANTAMENTO_SALARIO = 'ADIANTAMENTO_SALARIO',
  DECIMO_TERCEIRO = 'DECIMO_TERCEIRO',
  FERIAS = 'FERIAS',
  FREELANCE = 'FREELANCE',
  ALUGUEL = 'ALUGUEL',
  REEMBOLSO = 'REEMBOLSO',
  DIVIDENDOS = 'DIVIDENDOS',
  JUROS_RENDA_FIXA = 'JUROS_RENDA_FIXA',
  RESGATE = 'RESGATE',
  POUPANCA = 'POUPANCA',
  ACAO = 'ACAO',
  FII = 'FII',
  CRIPTO = 'CRIPTO',
  PENSAO = 'PENSAO',
  RESTITUICAO_IR = 'RESTITUICAO_IR',
  COMISSAO = 'COMISSAO',
  VENDA_BEM = 'VENDA_BEM',
  PRESENTE = 'PRESENTE',
  PIX_RECEBIDO = 'PIX_RECEBIDO',
  ALOCACAO_ORCAMENTO = 'ALOCACAO_ORCAMENTO', // Budget allocation from PESSOAL
  OUTROS = 'OUTROS',
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
  // PESSOAL-specific types
  CARTAO_CREDITO = 'CARTAO_CREDITO',
  MORADIA = 'MORADIA',
  ALIMENTACAO = 'ALIMENTACAO',
  TRANSPORTE = 'TRANSPORTE',
  SAUDE = 'SAUDE',
  EDUCACAO = 'EDUCACAO',
  LAZER = 'LAZER',
  BELEZA = 'BELEZA',
  PETS = 'PETS',
  SUPERMERCADO = 'SUPERMERCADO',
  FAXINEIRA = 'FAXINEIRA',
  AJUDA = 'AJUDA',
  REEMBOLSO_MEDICO = 'REEMBOLSO_MEDICO',
  ACADEMIA = 'ACADEMIA',
  ESTACIONAMENTO = 'ESTACIONAMENTO',
  GASOLINA = 'GASOLINA',
  LAVAGEM = 'LAVAGEM',
  ASSINATURAS = 'ASSINATURAS',
  INVESTIMENTOS = 'INVESTIMENTOS',
  SEGUROS_PESSOAIS = 'SEGUROS_PESSOAIS',
  IMPREVISTOS = 'IMPREVISTOS',
  OUTROS = 'OUTROS',
  MOVIMENTACAO_INTERNA = 'MOVIMENTACAO_INTERNA',
  // PESSOAL — categorias do consolidado financeiro (extrato + faturas)
  PIX_ENVIADO = 'PIX_ENVIADO',
  COMPRAS_VAREJO = 'COMPRAS_VAREJO',
  COMPRAS_DEBITO = 'COMPRAS_DEBITO',
  OBRA_REFORMA = 'OBRA_REFORMA',
  CONTAS_UTILIDADES = 'CONTAS_UTILIDADES',
  TELEFONE_INTERNET = 'TELEFONE_INTERNET',
  IMPOSTOS_IOF = 'IMPOSTOS_IOF',
  IMPOSTOS_TAXAS = 'IMPOSTOS_TAXAS',
  TARIFAS_BANCARIAS = 'TARIFAS_BANCARIAS',
  ESTORNOS_AJUSTES = 'ESTORNOS_AJUSTES',
  PAGAMENTO_BOLETO = 'PAGAMENTO_BOLETO',
  TRANSFERENCIA_TED = 'TRANSFERENCIA_TED',
  // CASA — pagamento da casa (aporte para o lar): neutro DE CONSUMO (sai do
  // gasto/KPIs, mas continua saindo do caixa como o aporte de investimento).
  PAGAMENTO_CASA = 'PAGAMENTO_CASA',
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
  PIX = 'PIX',
  PAGAMENTO_CONTA = 'PAGAMENTO_CONTA',
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
  [ReceiptType.SALARIO]: 'Salário',
  [ReceiptType.ADIANTAMENTO_SALARIO]: 'Adiantamento de Salário',
  [ReceiptType.DECIMO_TERCEIRO]: '13º Salário',
  [ReceiptType.FERIAS]: 'Férias',
  [ReceiptType.FREELANCE]: 'Freelance',
  [ReceiptType.ALUGUEL]: 'Aluguel',
  [ReceiptType.REEMBOLSO]: 'Reembolso',
  [ReceiptType.DIVIDENDOS]: 'Dividendos',
  [ReceiptType.JUROS_RENDA_FIXA]: 'Juros de Renda Fixa',
  [ReceiptType.RESGATE]: 'Resgate',
  [ReceiptType.POUPANCA]: 'Rend. Poupança',
  [ReceiptType.ACAO]: 'Ação (Operação)',
  [ReceiptType.FII]: 'Fundo Imobiliário',
  [ReceiptType.CRIPTO]: 'Criptomoeda',
  [ReceiptType.PENSAO]: 'Pensão / Aposentadoria',
  [ReceiptType.RESTITUICAO_IR]: 'Restituição IR',
  [ReceiptType.COMISSAO]: 'Comissão',
  [ReceiptType.VENDA_BEM]: 'Venda de Bem',
  [ReceiptType.PRESENTE]: 'Presente / Doação',
  [ReceiptType.PIX_RECEBIDO]: 'PIX Recebido',
  [ReceiptType.ALOCACAO_ORCAMENTO]: 'Alocação de Orçamento',
  [ReceiptType.OUTROS]: 'Outros',
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
  [ExpenseType.CARTAO_CREDITO]: 'Cartão de Crédito',
  [ExpenseType.MORADIA]: 'Moradia',
  [ExpenseType.ALIMENTACAO]: 'Alimentação',
  [ExpenseType.TRANSPORTE]: 'Transporte',
  [ExpenseType.SAUDE]: 'Saúde',
  [ExpenseType.EDUCACAO]: 'Educação',
  [ExpenseType.LAZER]: 'Lazer',
  [ExpenseType.BELEZA]: 'Beleza',
  [ExpenseType.PETS]: 'Pets',
  [ExpenseType.SUPERMERCADO]: 'Supermercado',
  [ExpenseType.FAXINEIRA]: 'Faxineira',
  [ExpenseType.AJUDA]: 'Ajuda',
  [ExpenseType.REEMBOLSO_MEDICO]: 'Reembolso Médico',
  [ExpenseType.ACADEMIA]: 'Academia',
  [ExpenseType.ESTACIONAMENTO]: 'Estacionamento',
  [ExpenseType.GASOLINA]: 'Gasolina',
  [ExpenseType.LAVAGEM]: 'Lavagem',
  [ExpenseType.ASSINATURAS]: 'Assinaturas',
  [ExpenseType.INVESTIMENTOS]: 'Investimentos',
  [ExpenseType.SEGUROS_PESSOAIS]: 'Seguros',
  [ExpenseType.IMPREVISTOS]: 'Imprevistos',
  [ExpenseType.OUTROS]: 'Outros',
  [ExpenseType.MOVIMENTACAO_INTERNA]: 'Movimentação entre contas próprias',
  [ExpenseType.PIX_ENVIADO]: 'PIX Enviado',
  [ExpenseType.COMPRAS_VAREJO]: 'Compras / Varejo',
  [ExpenseType.COMPRAS_DEBITO]: 'Compras no Débito',
  [ExpenseType.OBRA_REFORMA]: 'Obra / Reforma',
  [ExpenseType.CONTAS_UTILIDADES]: 'Contas / Utilidades',
  [ExpenseType.TELEFONE_INTERNET]: 'Telefone / Internet',
  [ExpenseType.IMPOSTOS_IOF]: 'Impostos / IOF',
  [ExpenseType.IMPOSTOS_TAXAS]: 'Impostos / Taxas',
  [ExpenseType.TARIFAS_BANCARIAS]: 'Tarifas Bancárias',
  [ExpenseType.ESTORNOS_AJUSTES]: 'Estornos / Ajustes',
  [ExpenseType.PAGAMENTO_BOLETO]: 'Pagamento / Boleto',
  [ExpenseType.TRANSFERENCIA_TED]: 'Transferência (TED)',
  [ExpenseType.PAGAMENTO_CASA]: 'Pagamento Casa',
};

/**
 * Tipos de despesa "neutros": movimentações que não representam consumo real
 * (transferência entre contas próprias, pagamento de fatura — cuja compra já
 * está nas despesas do cartão). NÃO geram cashflow, NÃO entram no saldo do
 * consolidado e NÃO somam no total da tela /expenses.
 */
export const NEUTRAL_EXPENSE_TYPES = new Set<string>([
  'PAGAMENTO_FATURA_CARTAO',
  ExpenseType.MOVIMENTACAO_INTERNA,
]);

export function isNeutralExpenseType(tipoDespesa: string | null | undefined): boolean {
  return !!tipoDespesa && NEUTRAL_EXPENSE_TYPES.has(tipoDespesa);
}

/**
 * Tipos de despesa "neutros DE CONSUMO": não representam consumo real, MAS — ao
 * contrário do neutro-de-caixa (settlement) acima — são saída de caixa NOVA e real.
 *
 * Superset de {@link NEUTRAL_EXPENSE_TYPES} + `INVESTIMENTOS` + `PAGAMENTO_CASA`.
 * Investir (aporte) e pagar a casa (aporte para o lar) não são gasto/consumo —
 * saem de despesa/gasto médio/categorias/resultado; mas o dinheiro SAIU da conta,
 * então PERMANECEM no eixo de caixa (§10, "Vai sair") — por isso NÃO entram em
 * `NEUTRAL_EXPENSE_TYPES` (settlement), que sumiria do fluxo de caixa.
 */
export const CONSUMPTION_NEUTRAL_EXPENSE_TYPES = new Set<string>([
  ...NEUTRAL_EXPENSE_TYPES,
  ExpenseType.INVESTIMENTOS,
  ExpenseType.PAGAMENTO_CASA,
]);

export function isConsumptionNeutralExpenseType(
  tipoDespesa: string | null | undefined,
): boolean {
  return !!tipoDespesa && CONSUMPTION_NEUTRAL_EXPENSE_TYPES.has(tipoDespesa);
}

/**
 * Tipos de RECEBIMENTO "neutros de consumo": retorno de principal que não é renda
 * nova. Simétrico ao aporte (`INVESTIMENTOS`): resgatar é o próprio dinheiro
 * voltando da corretora → sai da receita/resultado (senão o resultado inflaria),
 * mas o crédito real ainda entra no caixa da conta.
 *
 * MVP = `{RESGATE}`. Rendimentos (JUROS_RENDA_FIXA, DIVIDENDOS, POUPANCA, …) são
 * ganho REAL e permanecem como receita.
 */
export const NEUTRAL_RECEIPT_TYPES = new Set<string>([ReceiptType.RESGATE]);

export function isNeutralReceiptType(tipo: string | null | undefined): boolean {
  return !!tipo && NEUTRAL_RECEIPT_TYPES.has(tipo);
}

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
  [PaymentForm.PIX]: 'PIX',
  [PaymentForm.PAGAMENTO_CONTA]: 'Pagamento de Conta (boleto)',
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
