import { NextResponse, type NextRequest } from 'next/server'

const PROTECTED  = ['/dashboard', '/history', '/settings']
const AUTH_PAGES = ['/login', '/signup']

export function middleware(request: NextRequest) {
  const session    = request.cookies.get('__session')?.value
  const { pathname } = request.nextUrl

  const isProtected = PROTECTED.some(p => pathname.startsWith(p))
  const isAuthPage  = AUTH_PAGES.includes(pathname)

  if (isProtected && !session) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (isAuthPage && session) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
