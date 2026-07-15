import { ProjectType } from '@reformaflow/domain';

export interface ApoioStep {
  title: string;
  description: string;
  /** Optional slug (relative to the project's basePath) the step links to. */
  slug?: string;
}

export interface ApoioContent {
  /** One-line summary of what the project type is for. */
  intro: string;
  steps: ApoioStep[];
}

/**
 * Guia de primeiros passos por tipo de projeto — o "manual" reduzido a uma
 * sequência de ações, na ordem que faz sentido usar o app pela primeira vez.
 * Fonte: docs/manual-do-aplicativo.md (§4 a §8). Atualize os dois juntos.
 */
export const APOIO_CONTENT: Record<ProjectType, ApoioContent> = {
  [ProjectType.PESSOAL]: {
    intro:
      'O PESSOAL é o controle do seu dia a dia financeiro. Comece cadastrando de onde o dinheiro sai e entra, depois lance o resto no automático.',
    steps: [
      { title: 'Cadastre sua conta corrente', slug: 'bank-accounts', description: 'O saldo inicial da conta é a base do "caixa real" — sem isso os números do Cockpit não fecham.' },
      { title: 'Cadastre seus cartões', slug: 'credit-cards', description: 'Informe fechamento e vencimento. Dá pra importar fatura (OFX/CSV) depois, sem digitar parcela por parcela.' },
      { title: 'Lance uma despesa', slug: 'expenses', description: 'Use o assistente "+ Nova despesa": escolha se já foi paga ou é uma parcela futura, e o app cuida do resto.' },
      { title: 'Registre um recebimento', slug: 'receipts', description: 'Salário, dividendos etc. Dá pra configurar um plano automático em vez de lançar mês a mês.' },
      { title: 'Acompanhe o Cockpit', slug: 'monthly', description: 'Tela-mãe do PESSOAL: responde "como está meu mês" com caixa, resultado e projeção de fechamento.' },
      { title: 'Veja sua conta e faturas', slug: 'conta', description: 'Foco no caixa real e nas faturas de cartão — quanto você tem e o que ainda vai sair.' },
      { title: 'Fale com a Maria', slug: 'maria', description: 'Assistente financeiro: tira dúvidas e até lança despesa por voz.' },
    ],
  },
  [ProjectType.REFORMA]: {
    intro:
      'O REFORMA controla o custo e a execução de uma obra, do orçamento ao cronograma.',
    steps: [
      { title: 'Veja o Dashboard', slug: 'dashboard', description: 'Visão geral: dinheiro disponível, já pago e despesas planejado × pago por mês.' },
      { title: 'Lance as despesas da obra', slug: 'expenses', description: 'Igual ao PESSOAL, mas com Ambiente/Cômodo e tipos próprios (Material, Mão de Obra, Marcenaria...).' },
      { title: 'Organize os cômodos', slug: 'rooms', description: 'Ambientes da reforma e o custo de cada um.' },
      { title: 'Suba a planta', slug: 'floor-plans', description: 'Marque objetos compráveis direto na planta e vincule a despesas.' },
      { title: 'Monte o cronograma', slug: 'schedule', description: 'Etapas e tarefas com datas, dependências e % concluído.' },
      { title: 'Simule cenários de custo', slug: 'simulation', description: 'Compare "real" × "projetado" antes de decidir uma compra grande.' },
      { title: 'Compare preços', slug: 'price-compare', description: 'Cotações por item e fornecedor para achar o melhor preço.' },
      { title: 'Gerencie pendências', slug: 'pendencias', description: 'Quadro simples de "o que falta resolver" na obra.' },
    ],
  },
  [ProjectType.CASA]: {
    intro:
      'O CASA organiza as contas fixas, manutenções e lembretes da casa.',
    steps: [
      { title: 'Veja o Dashboard', slug: 'dashboard', description: 'Resumo geral da casa e próximas pendências.' },
      { title: 'Cadastre contas recorrentes', slug: 'bills', description: 'Luz, água, internet, gás... com valor, frequência e vencimento.' },
      { title: 'Lance uma despesa avulsa', slug: 'expenses', description: 'Para gastos pontuais que não são conta fixa.' },
      { title: 'Registre uma manutenção', slug: 'maintenance', description: 'Histórico e agenda: quando foi feita, quando é a próxima.' },
      { title: 'Crie um lembrete', slug: 'reminders', description: 'Tarefas com prazo e prioridade — conclua, adie ou edite quando quiser.' },
    ],
  },
  [ProjectType.CARRO]: {
    intro:
      'O CARRO é igual ao CASA (contas, manutenção, lembretes) e ainda guarda a ficha do veículo.',
    steps: [
      { title: 'Cadastre os dados do carro', slug: 'car-info', description: 'Marca, modelo, placa, tabela FIPE × valor pago e quilometragem.' },
      { title: 'Veja o Dashboard', slug: 'dashboard', description: 'Resumo geral do carro e próximas pendências.' },
      { title: 'Cadastre contas recorrentes', slug: 'bills', description: 'IPVA, seguro, licenciamento... com valor e vencimento.' },
      { title: 'Lance uma despesa avulsa', slug: 'expenses', description: 'Combustível, multa, lavagem — o que não é conta fixa nem manutenção.' },
      { title: 'Registre uma manutenção', slug: 'maintenance', description: 'Igual ao CASA, com a quilometragem da revisão.' },
      { title: 'Crie um lembrete', slug: 'reminders', description: 'Ex.: trocar óleo, revisar pneus.' },
    ],
  },
  [ProjectType.COMPRA]: {
    intro:
      'O COMPRA acompanha uma compra grande (imóvel, carro etc.) do sinal até o fechamento.',
    steps: [
      { title: 'Veja o Dashboard', slug: 'dashboard', description: 'Visão geral da compra.' },
      { title: 'Lance as despesas da compra', slug: 'expenses', description: 'Entrada, financiamento, documentação, cartório, imposto, seguro, vistoria, mudança.' },
      { title: 'Registre recebimentos', slug: 'receipts', description: 'Se houver entradas de dinheiro ligadas à compra.' },
      { title: 'Acompanhe o fluxo de caixa', slug: 'cash-flow', description: 'Projetado × realizado, lançamento a lançamento.' },
    ],
  },
  [ProjectType.PLANTAS]: {
    intro:
      'O PLANTAS ajuda a cuidar das suas plantas com diagnóstico por IA e agenda de cuidados.',
    steps: [
      { title: 'Cadastre suas plantas', slug: 'plants', description: 'Uma ficha por planta, com foto e espécie.' },
      { title: 'Peça um diagnóstico', slug: 'plants-ai', description: 'A IA analisa uma foto e sugere cuidados.' },
      { title: 'Veja os cuidados', slug: 'maintenance', description: 'Histórico e agenda de rega, adubação, poda etc.' },
      { title: 'Crie um lembrete', slug: 'reminders', description: 'Ex.: regar a cada 3 dias.' },
    ],
  },
};
