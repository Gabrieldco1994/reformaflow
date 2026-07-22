'use client';

import { useRouter } from 'next/navigation';
import { CreditCard } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';

interface SemCartaoEmptyStateProps {
  projectId: string;
}

export function SemCartaoEmptyState({ projectId }: SemCartaoEmptyStateProps) {
  const router = useRouter();

  return (
    <EmptyState
      icon={CreditCard}
      title="Nenhum cartão cadastrado"
      description="Comece adicionando um cartão para importar faturas e acompanhar o limite."
      action={{
        label: 'Novo cartão',
        onClick: () => {
          router.push(`/projects/${projectId}/credit-cards?new=1`);
        },
      }}
    />
  );
}
