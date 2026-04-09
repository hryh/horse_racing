import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export async function POST(request: NextRequest) {
  const { password } = await request.json()

  if (!process.env.SITE_PASSWORD || !process.env.SESSION_TOKEN) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 })
  }

  if (password !== process.env.SITE_PASSWORD) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.set("session_token", process.env.SESSION_TOKEN, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,   // 7 days
    path: "/",
  })
  return response
}
