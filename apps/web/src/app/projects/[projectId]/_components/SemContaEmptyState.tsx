'use client';

import { useRouter } from 'next/navigation';
import { Landmark } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';

interface SemContaEmptyStateProps {
  projectId: string;
}

export function SemContaEmptyState({ projectId }: SemContaEmptyStateProps) {
  const router = useRouter();

  return (
    <EmptyState
      icon={Landmark}
      title="Nenhuma conta cadastrada"
      description="Comece adicionando uma conta para importar extratos e acompanhar o saldo."
      action={{
        label: 'Nova conta',
        onClick: () => {
          router.push(`/projects/${projectId}/bank-accounts?focus=openingBalance`);
        },
      }}
    />
  );
}
