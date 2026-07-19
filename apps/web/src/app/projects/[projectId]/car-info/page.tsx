'use client';

import { useProject } from '@/contexts/project-context';
import { CarInfoForm } from './_components/CarInfoForm';

export default function CarInfoPage() {
  const { projectId } = useProject();
  return <CarInfoForm projectId={projectId} />;
}
