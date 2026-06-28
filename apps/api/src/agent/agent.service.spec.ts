import { ServiceUnavailableException } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentToolsService } from './tools/agent-tools.service';
import { LlmProvider, ToolDef } from './llm/llm.types';

const toolDefs: ToolDef[] = [
  { name: 'get_financial_overview', description: 'kpis', parameters: { type: 'object', properties: {} } },
];

function makeTools(overrides: Partial<AgentToolsService> = {}): AgentToolsService {
  return {
    getToolDefs: jest.fn().mockReturnValue(toolDefs),
    buildPrimer: jest.fn().mockResolvedValue(''),
    execute: jest.fn().mockResolvedValue({ caixaTotal: 150000 }),
    ...overrides,
  } as unknown as AgentToolsService;
}

describe('AgentService (loop de tool-calling)', () => {
  const baseInput = {
    tenantId: 'tenant-1',
    projectId: null,
    messages: [{ role: 'user' as const, content: 'Quanto tenho em caixa?' }],
  };

  it('executa a ferramenta pedida e reinjeta o resultado até a resposta final', async () => {
    const llm: LlmProvider = {
      id: 'mock',
      isConfigured: () => true,
      chat: jest
        .fn()
        // 1ª chamada: pede a ferramenta
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{ id: 'c1', name: 'get_financial_overview', arguments: {} }],
        })
        // 2ª chamada: resposta final (sem mais tools)
        .mockResolvedValueOnce({ content: 'Você tem R$ 1.500,00 em caixa.', toolCalls: [] }),
    };
    const tools = makeTools();
    const service = new AgentService(llm, tools);

    const res = await service.chat(baseInput);

    expect(res.reply).toBe('Você tem R$ 1.500,00 em caixa.');
    expect(res.toolsUsed).toEqual(['get_financial_overview']);
    expect(res.provider).toBe('mock');
    // a ferramenta foi executada com o tenant correto
    expect(tools.execute).toHaveBeenCalledWith(
      'get_financial_overview',
      { tenantId: 'tenant-1', projectId: null, projectScope: null },
      {},
    );
    // o LLM foi chamado 2x (pedido de tool + resposta final)
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('retorna direto quando o LLM responde sem ferramentas', async () => {
    const llm: LlmProvider = {
      id: 'mock',
      isConfigured: () => true,
      chat: jest.fn().mockResolvedValue({ content: 'Olá! Como posso ajudar?', toolCalls: [] }),
    };
    const tools = makeTools();
    const service = new AgentService(llm, tools);

    const res = await service.chat(baseInput);

    expect(res.reply).toBe('Olá! Como posso ajudar?');
    expect(res.toolsUsed).toEqual([]);
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it('normaliza markdown e espaço de moeda para formato legível', async () => {
    const llm: LlmProvider = {
      id: 'mock',
      isConfigured: () => true,
      chat: jest
        .fn()
        .mockResolvedValue({ content: '**Maior gasto:** categoria moradia em R$\u202f181.848,55.', toolCalls: [] }),
    };
    const tools = makeTools();
    const service = new AgentService(llm, tools);

    const res = await service.chat(baseInput);

    expect(res.reply).toBe('Maior gasto: categoria moradia em R$ 181.848,55.');
  });

  it('remove tópicos e numeração para resposta mais natural de voz', async () => {
    const llm: LlmProvider = {
      id: 'mock',
      isConfigured: () => true,
      chat: jest.fn().mockResolvedValue({
        content: '1. **Resumo**\n- Maior gasto: Moradia.\n- Valor: R$181.848,55.',
        toolCalls: [],
      }),
    };
    const tools = makeTools();
    const service = new AgentService(llm, tools);

    const res = await service.chat(baseInput);

    expect(res.reply).toBe('Resumo Maior gasto: Moradia. Valor: R$ 181.848,55.');
  });

  it('lança 503 quando o provider não está configurado', async () => {
    const llm: LlmProvider = {
      id: 'groq',
      isConfigured: () => false,
      chat: jest.fn(),
    };
    const service = new AgentService(llm, makeTools());

    await expect(service.chat(baseInput)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('força resposta final ao atingir o limite de iterações (loop de tools infinito)', async () => {
    const llm: LlmProvider = {
      id: 'mock',
      isConfigured: () => true,
      chat: jest.fn().mockImplementation(async (_messages, tools: ToolDef[]) => {
        // Enquanto houver tools disponíveis, continua pedindo ferramenta (loop).
        if (tools.length > 0) {
          return { content: '', toolCalls: [{ id: 'c', name: 'get_financial_overview', arguments: {} }] };
        }
        // Chamada final sem tools → resposta.
        return { content: 'Resposta final forçada.', toolCalls: [] };
      }),
    };
    const tools = makeTools();
    const service = new AgentService(llm, tools);

    const res = await service.chat(baseInput);

    expect(res.reply).toBe('Resposta final forçada.');
    // 6 iterações com tools + 1 chamada final sem tools
    expect(llm.chat).toHaveBeenCalledTimes(7);
  });
});
