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

    const handleWindowError = (event: ErrorEvent) => {
      const source =
        event.filename ||
        (event.message === 'Script error.' ? 'cross-origin' : 'inline');
      Clarity.setTag('jsErrorSource', source);
      Clarity.setTag('jsErrorMsg', (event.message || '').slice(0, 80));
    };

    window.addEventListener('error', handleWindowError);
    return () => {
      window.removeEventListener('error', handleWindowError);
    };
  }, []);

  return null;
}
