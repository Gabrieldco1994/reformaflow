'use client';

import React from 'react';

export function StatusBadge({ status }: { status: string }) {
  const styles = status === 'PAGO'
    ? 'bg-emerald-100 text-emerald-700'
    : 'bg-amber-100 text-amber-700';
  const label = status === 'PAGO' ? 'Pago' : 'Planejado';
  return <span className={`${styles} px-2 py-0.5 rounded-full text-xs font-medium`}>{label}</span>;
}

