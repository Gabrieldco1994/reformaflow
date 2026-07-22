import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VehicleDocumentsPage from './page';

const queryData = vi.hoisted(() => ({
  documents: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({
    projectId: 'project-1',
    projectType: 'CARRO',
    projectName: 'Meu carro',
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: queryData.documents,
    isLoading: false,
    isError: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));

describe('VehicleDocumentsPage', () => {
  beforeEach(() => {
    queryData.documents = [];
  });

  it('explica a integração com lembrete no cadastro', () => {
    render(<VehicleDocumentsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Novo documento' }));

    expect(screen.getByLabelText('Tipo')).toBeInTheDocument();
    expect(screen.getByLabelText('Vencimento')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Um lembrete será criado e mantido sincronizado com o vencimento.',
      ),
    ).toBeInTheDocument();
  });

  it('renderiza vencimento e anexo do documento', () => {
    queryData.documents = [
      {
        id: 'doc-1',
        tipo: 'SEGURO',
        titulo: 'Seguro 2027',
        numero: 'AP-123',
        dataVencimento: '2099-01-31T00:00:00.000Z',
        lembreteAntecedenciaDias: 30,
        observacoes: null,
        attachments: [
          {
            id: 'attachment-1',
            fileName: 'apolice.pdf',
            downloadUrl:
              '/projects/project-1/vehicle-documents/doc-1/attachments/attachment-1/download',
          },
        ],
      },
    ];

    render(<VehicleDocumentsPage />);

    expect(screen.getByText('Seguro 2027')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'apolice.pdf' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Em dia')).toBeInTheDocument();
  });
});
