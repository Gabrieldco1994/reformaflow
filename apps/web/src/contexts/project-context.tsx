'use client';

import { createContext, useContext } from 'react';

export interface ProjectContextValue {
  projectId: string;
  projectType: string;
  projectName: string;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({
  value,
  children,
}: {
  value: ProjectContextValue;
  children: React.ReactNode;
}) {
  return (
    <ProjectContext.Provider value={value}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used within ProjectProvider');
  return ctx;
}

export function useProjectOptional(): ProjectContextValue | null {
  return useContext(ProjectContext);
}
