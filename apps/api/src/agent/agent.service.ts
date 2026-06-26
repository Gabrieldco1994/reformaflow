import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AgentToolsService } from './tools/agent-tools.service';
import { ChatMessage, LLM_PROVIDER, LlmProvider } from './llm/llm.types';

export interface AgentChatInput {
  tenantId: string;
  projectId?: string | null;
  /** Escopo de projetos acessíveis (null = sem restrição). */
  projectScope?: string[] | null;
  /** Papel do usuário — habilita ferramentas de escrita com ACL correta. */
  role?: string;
  /** Módulos liberados ao usuário — usado nas ferramentas de escrita. */
  allowedModules?: string[];
  /** Histórico da conversa (apenas roles user/assistant). */
  messages: { role: 'user' | 'assistant'; content: string }[];
}

export interface AgentChatResult {
  reply: string;
  toolsUsed: string[];
  provider: string;
}

const MAX_ITERATIONS = 6;

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
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt(input.projectId) },
      ...input.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const toolsUsed: string[] = [];

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

    // Atingiu o limite de iterações: força uma resposta final sem ferramentas.
    this.logger.warn(`Limite de ${MAX_ITERATIONS} iterações atingido; forçando resposta final.`);
    const final = await this.llm.chat(
      [
        ...messages,
        { role: 'user', content: 'Responda agora, de forma objetiva, com base nos dados já coletados.' },
      ],
      [],
    );
    return { reply: this.ensureReply(final.content), toolsUsed, provider: this.llm.id };
  }

  private ensureReply(content: string): string {
    const trimmed = (content || '').trim();
    return trimmed || 'Não consegui gerar uma resposta. Pode reformular a pergunta?';
  }

  private systemPrompt(projectId?: string | null): string {
    const hoje = new Date().toISOString().slice(0, 10);
    return [
      'Você é o Copiloto Financeiro do ReformaFlow — além de registrar lançamentos, atua como',
      'CONSULTOR FINANCEIRO pessoal. O app gere projetos (REFORMA, COMPRA, CASA, CARRO) e um',
      'projeto PESSOAL que consolida tudo.',
      `Data de hoje: ${hoje}.`,
      '',
      'REGRAS GERAIS:',
      '- Responda SEMPRE em português do Brasil, de forma objetiva e amigável.',
      '- Use as ferramentas para obter QUALQUER número. NUNCA invente valores nem datas.',
      '- Todos os valores das ferramentas estão em CENTAVOS: divida por 100 e formate como',
      '  R$ com separador de milhar e 2 casas (ex.: 150000 -> R$ 1.500,00).',
      '- Seja conciso: destaque o número principal, depois 1-3 bullets de contexto/ação.',
      '- Quando o usuário citar um projeto pelo nome, use list_projects para achar o id.',
      '',
      'CADASTROS (escrita):',
      '- Você PODE cadastrar despesas (create_expense) e recebimentos (create_receipt).',
      '- Valores ditos pelo usuário estão em REAIS — passe em reais (as ferramentas convertem).',
      '- Extraia da fala: valor, título, fornecedor, categoria (tipoDespesa), data e forma de pagamento.',
      '  Ex.: "despesa Obramax 5000, dia 10/06, material de construção, projeto Reforma Casa" ->',
      '  create_expense(fornecedor=Obramax, valor=5000, data=2026-06-10, tipoDespesa=MATERIAL_CONSTRUCAO).',
      '- Cartão/conta ("no cartão Nubank", "saiu do Itaú"): use list_payment_methods e passe creditCardId/bankAccountId.',
      '- DESPESA DE OBRA PAGA COM DINHEIRO PESSOAL (regra de ouro): quando o usuário disser que pagou algo de um',
      '  projeto de obra/aquisição (REFORMA/COMPRA/CASA/CARRO) com o caixa/cartão/conta pessoal',
      '  (ex.: "paguei 140 de material da reforma pelo Itaú"), use create_obra_expense — NUNCA crie duas',
      '  despesas soltas. Ela cria o registro na obra + o espelho no PESSOAL (caixa), vinculados, sem duplicar.',
      '- Vínculo cross-project manual (a despesa-alvo JÁ existe em outro projeto): use find_expenses e passe',
      '  linkedExpenseId no create_expense.',
      '- Confirme em 1 frase os dados essenciais quando houver ambiguidade; se claro e houver projeto em foco, crie direto.',
      '- Após criar, confirme objetivamente (valor formatado, projeto, tipo e, se houver, cartão/conta/vínculo).',
      '',
      'CONSULTORIA (diagnóstico) — frameworks e quais ferramentas usar:',
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
