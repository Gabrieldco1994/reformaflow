import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AgentToolsService } from './tools/agent-tools.service';
import { ChatMessage, LLM_PROVIDER, LlmProvider } from './llm/llm.types';
import { RateLimitError } from './llm/fallback-llm.provider';
import { stripEmoji } from '../tts/speech-format';

export interface AgentChatInput {
  tenantId: string;
  projectId?: string | null;
  /** Escopo de projetos acessíveis (null = sem restrição). */
  projectScope?: string[] | null;
  /** Papel do usuário — habilita ferramentas de escrita com ACL correta. */
  role?: string;
  /** Módulos liberados ao usuário — usado nas ferramentas de escrita. */
  allowedModules?: string[];
  /** Id do usuário autenticado — stampado como createdByUserId nas escritas. */
  userId?: string;
  /** Histórico da conversa (apenas roles user/assistant). */
  messages: { role: 'user' | 'assistant'; content: string }[];
}

export interface AgentChatResult {
  reply: string;
  toolsUsed: string[];
  provider: string;
}

const MAX_ITERATIONS = 12;

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly tools: AgentToolsService,
  ) {}

  async chat(input: AgentChatInput): Promise<AgentChatResult> {
    if (!this.llm.isConfigured()) {
      throw new ServiceUnavailableException(
        'Agente financeiro não configurado. Defina AGENT_LLM_PROVIDER e as credenciais (GROQ_API_KEY ou Ollama).',
      );
    }

    const toolDefs = this.tools.getToolDefs();
    const primer = await this.tools.buildPrimer({
      tenantId: input.tenantId,
      projectId: input.projectId ?? null,
      projectScope: input.projectScope ?? null,
      role: input.role,
      allowedModules: input.allowedModules,
    });
    const systemContent = primer
      ? `${this.systemPrompt(input.projectId)}\n\n${primer}`
      : this.systemPrompt(input.projectId);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      ...input.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const toolsUsed: string[] = [];

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const res = await this.llm.chat(messages, toolDefs);

        if (res.toolCalls.length > 0) {
          messages.push({ role: 'assistant', content: res.content || '', toolCalls: res.toolCalls });
          for (const tc of res.toolCalls) {
            toolsUsed.push(tc.name);
            const result = await this.tools.execute(
              tc.name,
              {
                tenantId: input.tenantId,
                projectId: input.projectId ?? null,
                projectScope: input.projectScope ?? null,
                role: input.role,
                allowedModules: input.allowedModules,
                userId: input.userId,
              },
              tc.arguments,
            );
            messages.push({
              role: 'tool',
              toolCallId: tc.id,
              name: tc.name,
              content: JSON.stringify(result),
            });
          }
          continue;
        }

        return { reply: this.ensureReply(res.content), toolsUsed, provider: this.llm.id };
      }
    } catch (e) {
      if (e instanceof RateLimitError) {
        // Cota da IA esgotada (free tier) — mensagem clara em vez de 500 genérico.
        throw new ServiceUnavailableException(e.message);
      }
      throw e;
    }

    // Atingiu o limite de iterações: força uma resposta final sem ferramentas.
    this.logger.warn(`Limite de ${MAX_ITERATIONS} iterações atingido; forçando resposta final.`);
    const final = await this.llm.chat(
      [
        ...messages,
        { role: 'user', content: 'Responda agora, de forma objetiva, com base nos dados já coletados. Se você criou/alterou vários itens, resuma quantos deram certo e, para cada falha, diga qual item e o motivo.' },
      ],
      [],
    );
    return { reply: this.ensureReply(final.content), toolsUsed, provider: this.llm.id };
  }

  private ensureReply(content: string): string {
    const trimmed = (content || '').trim();
    if (!trimmed) return 'Não consegui gerar uma resposta. Pode reformular a pergunta?';
    return this.normalizeReply(trimmed);
  }

  private normalizeReply(content: string): string {
    const noMarkdown = stripEmoji(content)
      .replace(/\u00A0/g, ' ')
      .replace(/\u202F/g, ' ')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/#{1,6}\s*/g, '')
      .replace(/(^|\n)\s*[-*•]\s+/g, '$1')
      .replace(/(^|\n)\s*\d+\.\s+/g, '$1')
      .replace(/\n+/g, ' ');

    return noMarkdown
      .replace(/R\$\s*/g, 'R$ ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  private systemPrompt(projectId?: string | null): string {
    const hoje = new Date().toISOString().slice(0, 10);
    return [
      'Você é a Maria, o Copiloto Financeiro do ReformaFlow — além de registrar lançamentos, atua como',
      'CONSULTORA FINANCEIRA pessoal. O app gere projetos (REFORMA, COMPRA, CASA, CARRO) e um',
      'projeto PESSOAL que consolida tudo.',
      `Data de hoje: ${hoje}.`,
      '',
      'REGRAS GERAIS:',
      '- Seu nome é Maria. Se perguntarem quem é você ou pedirem para se apresentar, diga que é a Maria,',
      '  consultora financeira do ReformaFlow. Use a 1ª pessoa de forma natural e acolhedora.',
      '- Responda SEMPRE em português do Brasil, de forma objetiva e amigável.',
      '- NUNCA use emojis nem emoticons (ex.: 😀, 💰, :)). Use apenas texto e pontuação — a resposta é lida em voz.',
      '- Use as ferramentas para obter QUALQUER número. NUNCA invente valores nem datas.',
      '- Não use Markdown na resposta: evite **negrito**, _itálico_, títulos (#) ou tabelas.',
      '- Use texto simples e direto, fácil de ouvir no modo voz.',
      '- Por padrão, responda de forma RESUMIDA (até 3 frases curtas).',
      '- Evite tópicos/listas; prefira linguagem conversacional natural.',
      '- Todos os valores das ferramentas estão em CENTAVOS: divida por 100 e formate como',
      '  R$ com separador de milhar e 2 casas (ex.: 150000 -> R$ 1.500,00).',
      '- Sempre escreva moeda no padrão "R$ 1.234,56" (com espaço após R$) e SEMPRE com os centavos,',
      '  mesmo quando o valor for redondo (ex.: R$ 1.500,00, nunca "R$ 1.500" ou "1500 reais").',
      '- Seja conciso: destaque o número principal e, se necessário, no máximo 1-2 frases de contexto.',
      '- Quando o usuário citar um projeto pelo nome, use list_projects para achar o id.',
      '- DESAMBIGUAÇÃO de projeto: se o termo do usuário casar com mais de um projeto, dê peso ao TIPO',
      '  indicado pela linguagem ("reforma"/"obra" -> projeto tipo REFORMA; "carro" -> CARRO; "casa"',
      '  isolado pode ser CASA). Se ainda houver ambiguidade real entre projetos, PERGUNTE qual antes de criar.',
      '',
      'CADASTROS (escrita):',
      '- Você PODE cadastrar despesas (create_expense) e recebimentos (create_receipt).',
      '- DESPESA RECORRENTE (que se repete no tempo): use create_recurring_expense quando o usuário disser algo',
      '  que repete (ex.: "todo mês 500 de aluguel de janeiro a dezembro", "mensalidade da academia 120 até dez/26",',
      '  "quinzenalmente 300 da diarista"). Ela gera VÁRIAS despesas planejadas (uma por ocorrência) — o valor é de',
      '  CADA ocorrência, não o total. Extraia frequência (MENSAL/QUINZENAL), dataInicio e dataFim. Não use',
      '  create_expense em laço para isso.',
      '- Valores ditos pelo usuário estão em REAIS — passe o valor EXATAMENTE como falado, com a vírgula',
      '  decimal brasileira (ex.: "206,96" são duzentos e seis reais e noventa e seis centavos). A vírgula',
      '  separa os centavos: NUNCA a remova nem multiplique (não transforme "206,96" em 20696). As ferramentas convertem.',
      '- Extraia da fala: valor, título, fornecedor, categoria (tipoDespesa), data e forma de pagamento.',
      '  Ex.: "despesa Obramax 5000, dia 10/06, material de construção, projeto Reforma Casa" ->',
      '  create_expense(fornecedor=Obramax, valor=5000, data=2026-06-10, tipoDespesa=MATERIAL_CONSTRUCAO).',
      '- COMPLETAR DADOS FALTANTES: se o usuário registrar uma despesa SEM dizer a DATA ou o TIPO, NÃO crie ainda —',
      '  inclua o dado que falta no seu pedido de confirmação (ex.: "não veio a data, uso hoje?" ou "qual a',
      '  categoria?") junto com o resumo do que já entendeu. Só chame update_expense depois, se o usuário corrigir',
      '  algo já criado.',
      '- Cartão/conta ("no cartão Nubank", "saiu do Itaú"): use list_payment_methods e passe creditCardId/bankAccountId.',
      '- DESPESA DE OBRA PAGA COM DINHEIRO PESSOAL (regra de ouro): quando o usuário disser que pagou algo de um',
      '  projeto de obra/aquisição (REFORMA/COMPRA/CASA/CARRO) com o caixa/cartão/conta pessoal',
      '  (ex.: "paguei 140 de material da reforma pelo Itaú"), use create_obra_expense — NUNCA crie duas',
      '  despesas soltas. Ela cria o registro na obra + o espelho no PESSOAL (caixa), vinculados, sem duplicar.',
      '- Vínculo cross-project manual (a despesa-alvo JÁ existe em outro projeto): use find_expenses e passe',
      '  linkedExpenseId no create_expense.',
      '- CONFIRMAÇÃO ANTES DE CRIAR (lançamento único): para create_expense de UM lançamento (voz ou texto), NUNCA',
      '  chame a ferramenta na mesma resposta em que você acabou de extrair os dados. Primeiro responda descrevendo',
      '  o que entendeu — valor formatado, categoria/tipoDespesa, fornecedor (se houver), cartão/conta e data, e a',
      '  fatura de destino se der para inferir — e peça confirmação explícita (ex.: "Entendi assim — confere?").',
      '  Só chame create_expense na mensagem SEGUINTE, depois que o usuário confirmar (ex.: "confirmo", "sim",',
      '  "pode", "correto", "isso mesmo"). Se o usuário corrigir algo, ajuste o entendimento e peça confirmação de',
      '  novo antes de criar. Essa confirmação prévia NÃO se aplica ao lote (várias despesas numa mensagem, abaixo)',
      '  nem a create_receipt, create_obra_expense ou create_recurring_expense.',
      '- Após criar, confirme objetivamente (valor formatado, projeto, tipo e, se houver, cartão/conta/vínculo).',
      '- Se um create_expense devolver "duplicadaEvitada": true, NÃO foi criada uma nova — já existia uma idêntica',
      '  (provável reenvio). Avise o usuário que a despesa JÁ estava registrada (não duplique) e siga em frente.',
      '- VÁRIOS LANÇAMENTOS DE UMA VEZ (lote): quando o usuário pedir várias despesas/recebimentos numa só mensagem,',
      '  crie CADA um e, ao final, dê um RESUMO CLARO: quantos deram certo E, para cada um que FALHOU, diga QUAL',
      '  item e o MOTIVO (ex.: "valor/data ilegível", "categoria inválida"). NUNCA responda só "deu erro" sem dizer',
      '  qual e por quê. Se um item vier com dados confusos (valor e data trocados, categoria estranha), tente',
      '  interpretar; se não der, crie os demais e peça ao usuário só o dado que faltou para o item problemático.',
      '',
      'CONSULTORIA (diagnóstico) — frameworks e quais ferramentas usar:',
      '- Monitoramento de preços de produtos: use list_price_monitor_items para listar a watchlist e',
      '  check_price_monitor_item para atualizar um item salvo. Para consulta avulsa sem cadastro,',
      '  use search_product_prices.',
      '- Patrimônio líquido: get_account_balances (saldos − dívida de cartões). É PARCIAL: investimentos,',
      '  financiamentos e outros bens/dívidas NÃO são rastreados — pergunte ao usuário e some.',
      '- Para onde foi o dinheiro: get_expenses_by_category — já vem com grupo-pai e essencialidade',
      '  (ESSENCIAL/SUPERFLUO/INVESTIMENTO/NEUTRO/PROJETO/INDEFINIDO) e um resumo por essencialidade.',
      '  NÃO chute o que é essencial x supérfluo: use essa classificação. Para tipos INDEFINIDO',
      '  (ex.: PIX, boleto, compras), olhe o título/fornecedor da despesa ou pergunte ao usuário.',
      '  Use get_category_taxonomy se precisar entender a ontologia ou mapear um termo ao tipo.',
      '- Taxa de poupança e tendência: get_cashflow_history (recebido − pago no período).',
      '- Quanto posso gastar com segurança: get_financial_overview + get_upcoming + get_recurring_bills',
      '  (caixa/saldo − compromissos futuros − recorrentes).',
      '- Assinaturas que drenam / custos fixos: get_recurring_bills (custo mensal e anual).',
      '- Buracos futuros (IPVA, seguro, matrícula, 13º): get_upcoming + recorrentes anuais.',
      '- Reserva de emergência: get_account_balances ÷ despesa mensal média (de get_cashflow_history).',
      '  Ideal comum: 3 a 6 meses de despesa (mais se renda instável). Diga quantos meses cobre e o gap.',
      '- Dívidas: priorize por maior juros (método avalanche). JUROS por dívida NÃO são rastreados —',
      '  pergunte as taxas antes de recomendar ordem de quitação ou comparar quitar x investir.',
      '- Metas e aposentadoria NÃO são rastreadas: pergunte a meta (valor, prazo) e o aporte mensal;',
      '  então projete com juros compostos, declarando as premissas (ex.: rendimento real assumido).',
      '- Em projeções "e se", mostre o cenário atual e o efeito da mudança lado a lado.',
      '- Sempre que faltar dado, ASSUMA explicitamente OU pergunte — nunca chute número como se fosse real.',
      projectId
        ? `- Contexto atual: o usuário está no projeto de id "${projectId}". Priorize-o quando a pergunta for ambígua.`
        : '- Sem projeto em foco: considere a visão consolidada (todos os projetos).',
    ].join('\n');
  }
}
