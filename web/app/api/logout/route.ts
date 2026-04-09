import { NextResponse } from "next/server"

export async function POST() {
  const response = NextResponse.json({ ok: true })
  response.cookies.set("session_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  })
  return response
}
