import { ConflictException, NotFoundException } from '@nestjs/common';
import { ReminderService } from './reminder.service';

// Todas as datas de fixture e o "agora" (system time) são congelados
// explicitamente e testados em TZ=UTC E TZ=America/Sao_Paulo (ver
// package.json / CI) — data fixa + relógio real é bomba-relógio (scar #22
// do CLAUDE.md). Nunca usar `new Date()` sem mockar o clock num teste que
// compara contra "hoje".

function makeService(existing: any, update = jest.fn()) {
  const prisma = {
    reminder: {
      findFirst: jest.fn().mockResolvedValue(existing),
      update,
    },
    plant: {
      findFirst: jest.fn(),
    },
  } as any;
  return { service: new ReminderService(prisma), update, prisma };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('ReminderService.update — advanceRecurrence é UTC-safe (setUTCDate/getUTCDate, não setDate/getDate local)', () => {
  it('avança DIARIA por exatamente 1 dia UTC em instante absoluto, resultado independente do fuso do processo (2026-03-08, perto da virada de dia UTC)', async () => {
    // Esta asserção é intencionalmente TZ-INVARIANTE: setUTCDate/getUTCDate
    // nunca leem o fuso do processo, então o resultado abaixo tem que valer
    // idêntico rodando com TZ=UTC ou TZ=America/Sao_Paulo (mandato deste PR
    // — rodar as duas). Isso já foi confirmado localmente com os dois
    // comandos abaixo, ambos verdes.
    //
    // O que este teste NÃO consegue provar sozinho, rodando só nesses dois
    // fusos: que o bug antigo (setDate/getDate LOCAIS) dava resultado
    // diferente. Motivo, verificado empiricamente antes de escrever este
    // teste: para um fuso de offset CONSTANTE (sem DST) — TZ=UTC (offset 0)
    // e TZ=America/Sao_Paulo (offset -03:00 fixo, Brasil não observa DST
    // desde 2019) — "+N dias" via campos locais e via campos UTC produzem
    // SEMPRE o mesmo instante absoluto; a divergência só aparece quando o
    // intervalo [base, base+N dias] cruza uma transição real de DST, que só
    // existe em fusos que a observam (nenhum dos dois da convenção deste
    // lote). Provei a diferença rodando ESTE MESMO teste (com o bug antigo
    // ainda no código, setDate/getDate) sob `TZ=America/New_York npx jest
    // src/reminder` — falhou com 2026-03-09T05:30:00.000Z (1h adiantado,
    // porque 08/03->09/03/2026 em America/New_York cruza o spring-forward e
    // o código antigo preservava a hora de PAREDE local, não o instante
    // UTC) em vez do 2026-03-09T06:30:00.000Z esperado abaixo. Depois do fix
    // o mesmo comando passa. Isso não faz parte da matriz de CI (que é só
    // UTC + America/Sao_Paulo) porque nenhum dos dois fusos da convenção
    // consegue discriminar este bug — documentado aqui em vez de deixar
    // silencioso.
    //
    // Nota técnica que motivou esta forma de teste: mutar `process.env.TZ`
    // NO MEIO do teste (depois que o processo Jest já resolveu o fuso ICU
    // uma vez) NÃO é respeitado pelo shim de fake timers nem pelo `Date`
    // nativo dentro deste ambiente Jest — confirmado com probes descartáveis
    // antes de escrever isto (exatamente o alerta do PO). Só o fuso setado
    // ANTES do processo Node subir (`TZ=<fuso> npx jest ...`) é honrado.
    jest.useFakeTimers().setSystemTime(new Date('2026-03-08T00:00:00.000Z'));
    const existing = {
      id: 'r1',
      tenantId: 't1',
      projectId: 'p1',
      recorrencia: 'DIARIA',
      data: new Date('2026-03-08T06:30:00.000Z'),
      status: 'PENDENTE',
    };
    const { service, update } = makeService(existing);
    await service.update('t1', 'p1', 'r1', { status: 'CONCLUIDO' } as any);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { status: 'PENDENTE', data: new Date('2026-03-09T06:30:00.000Z') },
    });
  });
});

describe('ReminderService.update — recurrence advance (DIARIA/SEMANAL, sem drift a corrigir)', () => {
  it('advances SEMANAL reminder by 7 days and resets to PENDENTE on CONCLUIDO', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T00:00:00Z'));
    const existing = {
      id: 'r1',
      tenantId: 't1',
      projectId: 'p1',
      titulo: 'Regar planta',
      recorrencia: 'SEMANAL',
      data: new Date('2026-07-14T00:00:00Z'),
      status: 'PENDENTE',
    };
    const { service, update } = makeService(existing);
    await service.update('t1', 'p1', 'r1', { status: 'CONCLUIDO' } as any);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { status: 'PENDENTE', data: new Date('2026-07-21T00:00:00Z') },
    });
  });

  it('leaves UNICA reminders CONCLUIDO without advancing', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T00:00:00Z'));
    const existing = {
      id: 'r1',
      tenantId: 't1',
      projectId: 'p1',
      recorrencia: 'UNICA',
      data: new Date('2026-07-14T00:00:00Z'),
      status: 'PENDENTE',
    };
    const { service, update } = makeService(existing);
    await service.update('t1', 'p1', 'r1', { status: 'CONCLUIDO' } as any);
    expect(update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { status: 'CONCLUIDO' } });
  });

  it('rejects updates to reminders managed by vehicle documents', async () => {
    const existing = {
      id: 'r1',
      tenantId: 't1',
      projectId: 'p1',
      recorrencia: 'SEMANAL',
      data: new Date('2026-07-14T00:00:00Z'),
      status: 'PENDENTE',
      generatedBy: 'VEHICLE_DOCUMENT',
    };
    const { service, update } = makeService(existing);
    await expect(
      service.update('t1', 'p1', 'r1', { status: 'CONCLUIDO' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('ReminderService.update — R3: aritmética de calendário real (MENSAL/ANUAL)', () => {
  it('MENSAL com data em 31/01, concluído no prazo, avança para o último dia de fevereiro (não 02/03, não Invalid Date)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-31T00:00:00Z'));
    const existing = {
      id: 'r1', tenantId: 't1', projectId: 'p1',
      recorrencia: 'MENSAL',
      data: new Date('2026-01-31T00:00:00Z'),
      status: 'PENDENTE',
    };
    const { service, update } = makeService(existing);
    await service.update('t1', 'p1', 'r1', { status: 'CONCLUIDO' } as any);
    // 2026 não é bissexto: fevereiro tem 28 dias.
    expect(update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { status: 'PENDENTE', data: new Date('2026-02-28T00:00:00Z') },
    });
  });

  it('MENSAL com data em dia 31 avançando para um mês de 30 dias (março -> abril)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-31T00:00:00Z'));
    const existing = {
      id: 'r1', tenantId: 't1', projectId: 'p1',
      recorrencia: 'MENSAL',
      data: new Date('2026-03-31T00:00:00Z'),
      status: 'PENDENTE',
    };
    const { service, update } = makeService(existing);
    await service.update('t1', 'p1', 'r1', { status: 'CONCLUIDO' } as any);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { status: 'PENDENTE', data: new Date('2026-04-30T00:00:00Z') },
    });
  });

  it('ANUAL com data em 29/02 de ano bissexto, concluído, clampa para 28/02 no ano seguinte não-bissexto (sem Invalid Date)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2028-02-29T00:00:00Z'));
    const existing = {
      id: 'r1', tenantId: 't1', projectId: 'p1',
      recorrencia: 'ANUAL',
      data: new Date('2028-02-29T00:00:00Z'),
      status: 'PENDENTE',
    };
    const { service, update } = makeService(existing);
    await service.update('t1', 'p1', 'r1', { status: 'CONCLUIDO' } as any);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { status: 'PENDENTE', data: new Date('2029-02-28T00:00:00Z') },
    });
  });
});

describe('ReminderService.update — R2: conclusão de lembrete atrasado', () => {
  it('MENSAL esquecido 3 meses: conclusão hoje produz próxima ocorrência >= hoje (não uma data já passada)', async () => {
    // Lembrete tinha vencimento em 15/05, ninguém concluiu — só em 25/08.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-25T00:00:00Z'));
    const existing = {
      id: 'r1', tenantId: 't1', projectId: 'p1',
      recorrencia: 'MENSAL',
      data: new Date('2026-05-15T00:00:00Z'),
      status: 'PENDENTE',
    };
    const { service, update } = makeService(existing);
    await service.update('t1', 'p1', 'r1', { status: 'CONCLUIDO' } as any);
    const call = update.mock.calls[0][0];
    expect(call.data.data.getTime()).toBeGreaterThanOrEqual(new Date('2026-08-25T00:00:00Z').getTime());
    // base+1 ciclo (15/06) estaria no passado — a próxima ocorrência real é 15/09.
    expect(call.data.data).toEqual(new Date('2026-09-15T00:00:00Z'));
    expect(call.data.status).toBe('PENDENTE');
  });

  it('SEMANAL esquecido várias semanas também não regride: próxima ocorrência >= hoje', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-25T00:00:00Z'));
    const existing = {
      id: 'r1', tenantId: 't1', projectId: 'p1',
      recorrencia: 'SEMANAL',
      data: new Date('2026-07-14T00:00:00Z'),
      status: 'PENDENTE',
    };
    const { service, update } = makeService(existing);
    await service.update('t1', 'p1', 'r1', { status: 'CONCLUIDO' } as any);
    const call = update.mock.calls[0][0];
    expect(call.data.data.getTime()).toBeGreaterThanOrEqual(new Date('2026-08-25T00:00:00Z').getTime());
  });
});

describe('ReminderService.create — R5: vínculo opcional com planta (plantId)', () => {
  it('grava plantId quando a planta pertence ao mesmo tenant+projeto', async () => {
    const prisma = {
      plant: { findFirst: jest.fn().mockResolvedValue({ id: 'plant1' }) },
      reminder: { create: jest.fn().mockResolvedValue({ id: 'r1' }) },
    } as any;
    const service = new ReminderService(prisma);
    await service.create('t1', 'p1', {
      titulo: 'Regar', data: '2026-08-01', plantId: 'plant1',
    } as any);
    expect(prisma.plant.findFirst).toHaveBeenCalledWith({
      where: { id: 'plant1', tenantId: 't1', projectId: 'p1' },
    });
    expect(prisma.reminder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ plantId: 'plant1', tenantId: 't1', projectId: 'p1' }),
    });
  });

  it('rejeita plantId de outro tenant/projeto (evita vazamento cross-tenant)', async () => {
    const prisma = {
      plant: { findFirst: jest.fn().mockResolvedValue(null) },
      reminder: { create: jest.fn() },
    } as any;
    const service = new ReminderService(prisma);
    await expect(
      service.create('t1', 'p1', { titulo: 'Regar', data: '2026-08-01', plantId: 'plant-de-outro-tenant' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.reminder.create).not.toHaveBeenCalled();
  });

  it('grava plantId null quando não informado', async () => {
    const prisma = {
      plant: { findFirst: jest.fn() },
      reminder: { create: jest.fn().mockResolvedValue({ id: 'r1' }) },
    } as any;
    const service = new ReminderService(prisma);
    await service.create('t1', 'p1', { titulo: 'Comprar tinta', data: '2026-08-01' } as any);
    expect(prisma.plant.findFirst).not.toHaveBeenCalled();
    expect(prisma.reminder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ plantId: null }),
    });
  });
});

describe('ReminderService.findAll — inclui { id, nome } da planta vinculada (R6, consumido pelo frontend p/ exibir o nome)', () => {
  it('retorna plant: { id, nome } quando plantId está setado e a planta está viva', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'r1',
        tenantId: 't1',
        projectId: 'p1',
        plantId: 'plant1',
        titulo: 'Regar',
        plant: { id: 'plant1', nome: 'Jiboia da sala', deletedAt: null },
      },
    ]);
    const prisma = { reminder: { findMany } } as any;
    const service = new ReminderService(prisma);
    const result = await service.findAll('t1', 'p1');
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: 't1', projectId: 'p1' },
      orderBy: { data: 'asc' },
      include: { plant: { select: { id: true, nome: true, deletedAt: true } } },
    });
    expect(result).toEqual([
      expect.objectContaining({ id: 'r1', plant: { id: 'plant1', nome: 'Jiboia da sala' } }),
    ]);
  });

  it('retorna plant: null quando plantId não está setado', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'r2', tenantId: 't1', projectId: 'p1', plantId: null, titulo: 'Comprar tinta', plant: null },
    ]);
    const prisma = { reminder: { findMany } } as any;
    const service = new ReminderService(prisma);
    const result = await service.findAll('t1', 'p1');
    expect(result).toEqual([expect.objectContaining({ id: 'r2', plant: null })]);
  });

  it('nulifica plant quando a planta vinculada foi soft-deletada — o middleware de soft-delete (`$use`) só intercepta a ação de nível superior e não filtra relações trazidas via `include` na mesma query, então isso tem que ser tratado explicitamente no service', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'r3',
        tenantId: 't1',
        projectId: 'p1',
        plantId: 'plant-deletada',
        titulo: 'Regar',
        plant: { id: 'plant-deletada', nome: 'Suculenta', deletedAt: new Date('2026-08-01T00:00:00Z') },
      },
    ]);
    const prisma = { reminder: { findMany } } as any;
    const service = new ReminderService(prisma);
    const result = await service.findAll('t1', 'p1');
    expect(result).toEqual([expect.objectContaining({ id: 'r3', plant: null })]);
  });
});
