'use client';

import Link from 'next/link';
import { CreditCard } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';

interface SemCartaoEmptyStateProps {
  projectId: string;
}

export function SemCartaoEmptyState({ projectId }: SemCartaoEmptyStateProps) {
  return (
    <EmptyState
      icon={CreditCard}
      title="Nenhum cartão cadastrado"
      description="Comece adicionando um cartão para importar faturas e acompanhar o limite."
      action={{
        label: 'Novo cartão',
        onClick: () => {
          // This handler is for when the component is used outside of credit-cards page.
          // Inside credit-cards page, use the Link href directly for consistency.
          window.location.href = `/projects/${projectId}/credit-cards?new=1`;
        },
      }}
    />
  );
}

export function SemCartaoEmptyStateLink({ projectId }: SemCartaoEmptyStateProps) {
  return (
    <Link href={`/projects/${projectId}/credit-cards?new=1`}>
      <EmptyState
        icon={CreditCard}
        title="Nenhum cartão cadastrado"
        description="Comece adicionando um cartão para importar faturas e acompanhar o limite."
        action={{
          label: 'Novo cartão',
          onClick: () => {},
        }}
      />
    </Link>
  );
}
