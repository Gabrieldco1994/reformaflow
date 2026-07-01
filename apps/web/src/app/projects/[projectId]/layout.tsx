'use client';

import { AppShell } from './_components/AppShell';

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
