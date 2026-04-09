import { NextRequest, NextResponse } from "next/server"

export const maxDuration = 60

export async function GET(request: NextRequest) {
  const renderUrl = process.env.RENDER_API_URL
  if (!renderUrl) {
    return NextResponse.json({ error: "RENDER_API_URL not set" }, { status: 500 })
  }
  const params = request.nextUrl.searchParams.toString()
  try {
    const res = await fetch(`${renderUrl}/predict?${params}`, {
      signal: AbortSignal.timeout(55_000),
      cache: "no-store",
    })
    return NextResponse.json(await res.json(), { status: res.status })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
