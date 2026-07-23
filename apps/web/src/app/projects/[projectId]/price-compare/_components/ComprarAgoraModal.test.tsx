import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComprarAgoraModal } from './ComprarAgoraModal';

vi.mock('@/components/ui/modal', () => ({
  Modal: ({
    children,
    portal,
  }: {
    children: React.ReactNode;
    portal?: boolean;
  }) => (
    <div data-testid="modal" data-portal={String(portal)}>
      {children}
    </div>
  ),
}));

describe('ComprarAgoraModal', () => {
  it('renderiza no body para permanecer visível dentro de layouts com transform', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <ComprarAgoraModal
          projectId="project-1"
          item={{
            id: 'item-1',
            title: 'Geladeira',
            lastBestPriceCents: 419_900,
            referencePriceCents: null,
          }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('modal')).toHaveAttribute('data-portal', 'true');
  });
});
