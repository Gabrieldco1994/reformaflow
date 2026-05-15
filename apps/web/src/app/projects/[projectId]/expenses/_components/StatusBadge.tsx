'use client';

import React from 'react';

export function StatusBadge({ status }: { status: string }) {
  const styles = status === 'PAGO'
    ? 'bg-green-100 text-green-800'
    : 'bg-amber-100 text-amber-800';
  const label = status === 'PAGO' ? 'Pago' : 'Planejado';
  return <span className={`${styles} px-2 py-0.5 rounded-full text-xs font-medium`}>{label}</span>;
}

