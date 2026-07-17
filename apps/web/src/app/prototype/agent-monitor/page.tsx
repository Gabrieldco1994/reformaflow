import { notFound } from 'next/navigation';

import { AgentMonitorClient } from './_components/AgentMonitorClient';

export default function AgentMonitorPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }
  return <AgentMonitorClient />;
}
