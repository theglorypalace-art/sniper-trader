import { NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/api/login'];

export function middleware(request) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p)) || pathname.startsWith('/_next')) {
    return NextResponse.next();
  }

  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    // Fail closed: no password configured means no access, rather than
    // leaving trade controls open to anyone who finds the URL.
    return new NextResponse('DASHBOARD_PASSWORD is not configured on the server.', { status: 503 });
  }

  const cookie = request.cookies.get('dashboard_auth')?.value;
  if (cookie !== expected) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
