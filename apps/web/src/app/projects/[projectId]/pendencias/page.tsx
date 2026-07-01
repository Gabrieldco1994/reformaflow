'use client';

import { useParams } from 'next/navigation';
import { useProject } from '@/contexts/project-context';
import { useAuth } from '@/contexts/auth-context';
import { PendenciaBoard } from './_components/PendenciaBoard';

export default function PendenciasPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { projectType } = useProject();
  const { hasModule } = useAuth();

  if ((projectType && projectType !== 'REFORMA') || !hasModule('pendencias')) {
    return (
      <div className="rounded-[14px] bg-lifeone-card shadow-lifeone-card border border-lifeone-hairline p-6 text-center">
        <p className="text-[14px] text-lifeone-ink-2">
          As pendências estão disponíveis apenas para projetos do tipo <strong>Reforma</strong>.
        </p>
      </div>
    );
  }

  return <PendenciaBoard projectId={projectId} />;
}
