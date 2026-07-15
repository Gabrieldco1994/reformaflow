import { NextResponse } from 'next/server';

import { readMonitorSnapshot } from '../../_lib/snapshot';

export const runtime = 'nodejs';

export async function GET() {
  const payload = readMonitorSnapshot();
  return NextResponse.json({
    now: new Date().toISOString(),
    ...payload,
  });
}
