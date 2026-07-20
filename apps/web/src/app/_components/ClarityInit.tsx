'use client';

import { useEffect } from 'react';
import Clarity from '@microsoft/clarity';

const CLARITY_FALLBACK_PROJECT_ID = 'xp2t8pv3uc';
const clarityProjectId = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID?.trim() || CLARITY_FALLBACK_PROJECT_ID;

export function ClarityInit() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!clarityProjectId) return;

    Clarity.init(clarityProjectId);
  }, []);

  return null;
}
