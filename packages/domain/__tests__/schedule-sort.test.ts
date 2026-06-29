import { describe, it, expect } from 'vitest';
import {
  compareTasksByDate,
  compareStagesByDate,
  sortScheduleByDate,
  recalculateAllTasks,
  type TaskForRecalc,
  type ScheduleDateConfig,
} from '../src/calculations/schedule-engine';

const cfg: ScheduleDateConfig = {
  trabalhaDiasUteis: true,
  trabalhaSabados: false,
  feriados: [],
};

describe('compareTasksByDate', () => {
  it('ordena por dataInicio ascendente', () => {
    const a = { dataInicio: '2026-01-10', numero: 1, ordem: 0 };
    const b = { dataInicio: '2026-01-05', numero: 2, ordem: 1 };
    expect(compareTasksByDate(a, b)).toBeGreaterThan(0);
    expect(compareTasksByDate(b, a)).toBeLessThan(0);
  });

  it('aceita Date e string indistintamente', () => {
    const a = { dataInicio: new Date('2026-01-10T12:00:00Z'), numero: 1, ordem: 0 };
    const b = { dataInicio: '2026-01-10T12:00:00Z', numero: 2, ordem: 1 };
    // mesma data → desempata por numero
    expect(compareTasksByDate(a, b)).toBeLessThan(0);
  });

  it('desempata por dataTermino quando inicio é igual', () => {
    const a = { dataInicio: '2026-01-10', dataTermino: '2026-01-20', numero: 5, ordem: 0 };
    const b = { dataInicio: '2026-01-10', dataTermino: '2026-01-15', numero: 4, ordem: 1 };
    expect(compareTasksByDate(a, b)).toBeGreaterThan(0);
  });

  it('desempata por numero quando inicio e termino são iguais', () => {
    const a = { dataInicio: '2026-01-10', dataTermino: '2026-01-20', numero: 7, ordem: 0 };
    const b = { dataInicio: '2026-01-10', dataTermino: '2026-01-20', numero: 3, ordem: 1 };
    expect(compareTasksByDate(a, b)).toBeGreaterThan(0);
  });

  it('coloca tarefas sem dataInicio no final', () => {
    const dated = { dataInicio: '2026-01-10', numero: 1, ordem: 0 };
    const undated = { dataInicio: null, numero: 2, ordem: 1 };
    expect(compareTasksByDate(undated, dated)).toBeGreaterThan(0);
    expect(compareTasksByDate(dated, undated)).toBeLessThan(0);
  });
});

describe('compareStagesByDate', () => {
  it('ordena etapas pela data de início da primeira tarefa', () => {
    const early = { ordem: 5, tasks: [{ dataInicio: '2026-02-01', numero: 1, ordem: 0 }] };
    const late = { ordem: 0, tasks: [{ dataInicio: '2026-03-01', numero: 2, ordem: 0 }] };
    expect(compareStagesByDate(early, late)).toBeLessThan(0);
  });

  it('coloca etapas vazias (sem datas) no final preservando ordem relativa', () => {
    const empty = { ordem: 2, tasks: [] };
    const dated = { ordem: 9, tasks: [{ dataInicio: '2026-03-01', numero: 1, ordem: 0 }] };
    expect(compareStagesByDate(empty, dated)).toBeGreaterThan(0);
  });
});

describe('sortScheduleByDate', () => {
  it('reordena tarefas por data dentro da etapa, ignorando ordem de inserção', () => {
    const stages = [
      {
        id: 's1',
        ordem: 0,
        tasks: [
          { id: 't1', dataInicio: '2026-01-20', numero: 1, ordem: 0 },
          { id: 't2', dataInicio: '2026-01-05', numero: 2, ordem: 1 }, // criada depois mas começa antes
          { id: 't3', dataInicio: '2026-01-12', numero: 3, ordem: 2 },
        ],
      },
    ];
    const sorted = sortScheduleByDate(stages);
    expect(sorted[0].tasks.map((t) => t.id)).toEqual(['t2', 't3', 't1']);
  });

  it('reordena etapas pela primeira tarefa', () => {
    const stages = [
      { id: 'sB', ordem: 0, tasks: [{ id: 'b1', dataInicio: '2026-03-01', numero: 2, ordem: 0 }] },
      { id: 'sA', ordem: 1, tasks: [{ id: 'a1', dataInicio: '2026-01-01', numero: 1, ordem: 0 }] },
    ];
    const sorted = sortScheduleByDate(stages);
    expect(sorted.map((s) => s.id)).toEqual(['sA', 'sB']);
  });

  it('não muta os arrays de entrada', () => {
    const tasks = [
      { id: 't1', dataInicio: '2026-01-20', numero: 1, ordem: 0 },
      { id: 't2', dataInicio: '2026-01-05', numero: 2, ordem: 1 },
    ];
    const stages = [{ id: 's1', ordem: 0, tasks }];
    sortScheduleByDate(stages);
    expect(tasks.map((t) => t.id)).toEqual(['t1', 't2']); // inalterado
  });

  it('respeita predecessoras: uma tarefa criada por último mas dependente fica após a predecessora', () => {
    // numero 3 é criada por último (ordem alta) mas depende da numero 1 → deve ficar logo após a 1
    const tasksForRecalc: TaskForRecalc[] = [
      { id: 't1', numero: 1, duracao: 3, predecessoras: [], dataInicio: new Date('2026-01-05T12:00:00Z'), dataTermino: null },
      { id: 't2', numero: 2, duracao: 2, predecessoras: [], dataInicio: new Date('2026-02-10T12:00:00Z'), dataTermino: null },
      { id: 't3', numero: 3, duracao: 2, predecessoras: [1], dataInicio: null, dataTermino: null },
    ];
    const results = recalculateAllTasks(tasksForRecalc, new Date('2026-01-05T12:00:00Z'), cfg);
    const byId = new Map(results.map((r) => [r.id, r]));
    const stages = [
      {
        id: 's1',
        ordem: 0,
        tasks: tasksForRecalc.map((t, i) => ({
          id: t.id,
          numero: t.numero,
          ordem: i,
          dataInicio: byId.get(t.id)!.dataInicio,
          dataTermino: byId.get(t.id)!.dataTermino,
        })),
      },
    ];
    const sorted = sortScheduleByDate(stages);
    // t1 (05/jan) → t3 (depende da 1, ~10/jan) → t2 (10/fev)
    expect(sorted[0].tasks.map((t) => t.id)).toEqual(['t1', 't3', 't2']);
  });
});
