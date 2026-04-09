import { NextResponse } from "next/server"

export const maxDuration = 30

export async function GET() {
  const renderUrl = process.env.RENDER_API_URL
  if (!renderUrl) return NextResponse.json({ ready: false }, { status: 500 })
  try {
    const res = await fetch(`${renderUrl}/health`, {
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
    })
    const data = await res.json()
    return NextResponse.json({ ready: res.ok && data.status === "ok" })
  } catch {
    return NextResponse.json({ ready: false })
  }
}
