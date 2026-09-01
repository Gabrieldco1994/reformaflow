import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SchedulePage from './page';
import { ProjectProvider } from '@/contexts/project-context';
import { api } from '@/lib/api';
import type { GanttData, ScheduleStage } from './_types';

// Contrato de view (#647): quando o projeto REFORMA JÁ TEM cronograma
// (`hasData = data.stages.length > 0`), o único ponto de entrada da importação
// vivia no header desktop (`hidden md:flex`) — invisível em 375/390px. O header
// mobile editorial (`div.md:hidden`) passa a expor um botão "Importar" que abre
// o MESMO `ImportModal` (`setShowImport(true)`), com a confirmação destrutiva
// em 2 passos do #607. Sem cronograma o empty-state já tem o botão — não
// duplicar. Desktop inalterado.

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}));

// Componentes pesados fora do escopo deste contrato — o teste é sobre o header
// mobile e o ImportModal (este NÃO é mockado, queremos asserir que monta).
vi.mock('./_components/GanttChart', () => ({ GanttChart: () => <div data-testid="gantt-chart" /> }));
vi.mock('./_components/MobileGanttList', () => ({
  MobileGanttList: () => <div data-testid="mobile-gantt-list" />,
}));
vi.mock('./_components/KPICards', () => ({ KPICards: () => <div data-testid="kpi-cards" /> }));
vi.mock('./_components/ConfigPanel', () => ({ ConfigPanel: () => <div data-testid="config-panel" /> }));
vi.mock('./_components/AddTaskModal', () => ({ AddTaskModal: () => <div data-testid="add-task-modal" /> }));
vi.mock('./_components/AddStageModal', () => ({ AddStageModal: () => <div data-testid="add-stage-modal" /> }));

const get = api.get as ReturnType<typeof vi.fn>;

const CONFIG = {
  id: 'cfg-1',
  dataInicio: '2026-01-06T12:00:00.000Z',
  trabalhaDiasUteis: true,
  trabalhaSabados: false,
};

const KPIS = {
  totalOrcado: 0,
  totalReal: 0,
  totalDesvio: 0,
  percentualTotal: 0,
  terminoPrevisto: null,
};

const STAGE_WITH_TASK: ScheduleStage = {
  id: 'stage-1',
  nome: 'DEMOLIÇÃO',
  ordem: 1,
  tasks: [
    {
      id: 't1',
      stageId: 'stage-1',
      numero: 1,
      nome: 'Demolir revestimentos',
      duracao: 3,
      dataInicio: null,
      dataTermino: null,
      predecessoras: null,
      valorOrcado: null,
      custoReal: null,
      percentualConcluido: 0,
      ordem: 1,
    },
  ],
};

function gantt(stages: ScheduleStage[]): GanttData {
  return { config: CONFIG, stages, holidays: [], kpis: KPIS };
}

function renderPage(stages: ScheduleStage[]) {
  get.mockResolvedValue(gantt(stages));
  return render(
    <ProjectProvider value={{ projectId: 'p1', projectType: 'REFORMA', projectName: 'Reforma' }}>
      <SchedulePage />
    </ProjectProvider>,
  );
}

/** O header mobile editorial é o `div.md:hidden` que contém o eyebrow "Obra". */
function mobileHeader(): HTMLElement {
  return screen.getByText('Obra').closest('div[class*="md:hidden"]') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SchedulePage — ponto de entrada mobile da importação (#647)', () => {
  it('com cronograma (hasData): expõe "Importar" no header mobile e abre o ImportModal com a confirmação destrutiva', async () => {
    const user = userEvent.setup();
    renderPage([STAGE_WITH_TASK]);

    await waitFor(() => expect(screen.getByText('Obra')).toBeInTheDocument());

    const importBtn = within(mobileHeader()).getByRole('button', { name: /importar/i });
    expect(importBtn).toBeInTheDocument();

    await user.click(importBtn);

    // Mesmo ImportModal do #607: passo 1 com aviso de substituição + contagens.
    expect(await screen.findByRole('heading', { name: 'Importar Cronograma' })).toBeInTheDocument();
    expect(screen.getByText('Isto vai substituir o cronograma atual.')).toBeInTheDocument();
    expect(screen.getByText(/1 etapa e 1 tarefa/)).toBeInTheDocument();
  });

  it('desktop inalterado: o botão "Importar" do header desktop continua existindo (2 no total quando hasData)', async () => {
    renderPage([STAGE_WITH_TASK]);

    await waitFor(() => expect(screen.getByText('Obra')).toBeInTheDocument());

    // 1 no header desktop (`hidden md:flex`) + 1 no header mobile (`md:hidden`).
    expect(screen.getAllByRole('button', { name: 'Importar' })).toHaveLength(2);
  });

  it('sem cronograma (!hasData): NÃO duplica o botão no header mobile (só o do empty-state)', async () => {
    renderPage([]);

    await waitFor(() => expect(screen.getByText('Obra')).toBeInTheDocument());

    expect(within(mobileHeader()).queryByRole('button', { name: /importar/i })).not.toBeInTheDocument();
    // Empty-state usa "Importar Modelo de Obra"; o único botão de nome exato
    // "Importar" é o do header desktop.
    expect(screen.getAllByRole('button', { name: 'Importar' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Importar Modelo de Obra' })).toBeInTheDocument();
  });
});
