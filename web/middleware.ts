import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// Protect all /dashboard routes.
// SESSION_TOKEN is a secret random string stored in Vercel env vars.
// The login route sets this value as the cookie; we compare here.
export function middleware(request: NextRequest) {
  const sessionCookie = request.cookies.get("session_token")?.value
  const expectedToken = process.env.SESSION_TOKEN

  if (!expectedToken) {
    // Env var missing — deny all access so misconfiguration is obvious
    return new NextResponse("SERVER_MISCONFIGURED: SESSION_TOKEN not set", { status: 500 })
  }

  if (sessionCookie !== expectedToken) {
    const loginUrl = new URL("/", request.url)
    loginUrl.searchParams.set("next", request.nextUrl.pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/dashboard/:path*"],
}
