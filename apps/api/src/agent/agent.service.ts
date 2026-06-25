import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AgentToolsService } from './tools/agent-tools.service';
import { ChatMessage, LLM_PROVIDER, LlmProvider } from './llm/llm.types';

export interface AgentChatInput {
  tenantId: string;
  projectId?: string | null;
  /** Escopo de projetos acessíveis (null = sem restrição). */
  projectScope?: string[] | null;
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
            { tenantId: input.tenantId, projectId: input.projectId ?? null, projectScope: input.projectScope ?? null },
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
      'Você é o Copiloto Financeiro do ReformaFlow, um app de gestão financeira de projetos',
      '(REFORMA, COMPRA, CASA, CARRO) e um projeto PESSOAL que consolida tudo.',
      `Data de hoje: ${hoje}.`,
      '',
      'REGRAS:',
      '- Responda SEMPRE em português do Brasil, de forma objetiva e amigável.',
      '- Use as ferramentas para obter QUALQUER número. NUNCA invente valores nem datas.',
      '- Se os dados não existirem nas ferramentas, diga que não tem essa informação.',
      '- Todos os valores monetários das ferramentas estão em CENTAVOS: divida por 100 e',
      '  formate como R$ com separador de milhar e 2 casas (ex.: 150000 -> R$ 1.500,00).',
      '- Seja conciso: prefira frases curtas e listas. Destaque o número principal.',
      '- Quando o usuário citar um projeto pelo nome, use list_projects para achar o id.',
      projectId
        ? `- Contexto atual: o usuário está no projeto de id "${projectId}". Priorize-o quando a pergunta for ambígua.`
        : '- Sem projeto em foco: considere a visão consolidada (todos os projetos).',
    ].join('\n');
  }
}
