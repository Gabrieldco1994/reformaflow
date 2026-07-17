import { NextResponse, type NextRequest } from 'next/server';

const LEGACY_MOBILE_ROUTES: Record<string, string> = {
  '/app-skin-minimal.html': '/app?screen=hoje',
  '/cockpit-inovador-c3.html': '/app?screen=hoje',
  '/app-despesas.html': '/app?screen=despesas',
  '/app-maria.html': '/app?screen=maria',
  '/app-lancar.html': '/app?screen=lancar',
};

const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/_next',
  '/favicon.ico',
  '/api',
  '/prototype/agent-monitor',
  '/skin-mobile-base.css',
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const legacyTarget = LEGACY_MOBILE_ROUTES[pathname];

  if (legacyTarget) {
    const url = req.nextUrl.clone();
    url.pathname = '/app';
    url.search = legacyTarget.split('?')[1] ? `?${legacyTarget.split('?')[1]}` : '';
    return NextResponse.redirect(url);
  }

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const token = req.cookies.get('rf_token')?.value;
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    // ponytail: preserve canonical in-app screen/query through login
    url.search = '';
    url.searchParams.set('next', `${pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|uploads).*)'],
};
