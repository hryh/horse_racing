import { NextRequest, NextResponse } from "next/server"

// ── Region pinning ──────────────────────────────────────────────────────────
// Stake geo-blocks US IPs (returns a "restrictedRegion" shell with no race data).
// Vercel's default region is iad1 (US). IMPORTANT: on the Hobby plan only a
// SINGLE preferred region is allowed — passing an array (multi-region) is a
// Pro/Enterprise feature and is silently ignored, dropping back to iad1 (US).
// So this MUST be a single string. Hong Kong (hkg1) is the natural choice for
// HK racing and is not geo-restricted by Stake.
export const preferredRegion = "hkg1"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const VENUE_SLUG: Record<string, string> = {
  ST: "sha-tin",
  HV: "happy-valley",
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const BASE = "https://stake.com/sports/racing/horse-racing/asia"

async function fetchHtml(url: string, timeoutMs = 18_000): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return null
    return await r.text()
  } catch {
    return null
  }
}

function looksGeoBlocked(html: string): boolean {
  return /restrictedRegion|not available in your (region|country)|access from your country is restricted/i.test(
    html
  )
}

// ── Meeting discovery ───────────────────────────────────────────────────────
// Race URLs on a calendar page look like:
//   /sports/racing/horse-racing/asia/meeting/{meetingMs}-{slug}/{raceMs}-{slug}-r{N}-{name}
interface RaceLink {
  raceNo: number
  url: string
}

function discoverRaces(html: string, venueSlug: string, ymd: string | null): RaceLink[] {
  const re = new RegExp(
    "/sports/racing/horse-racing/asia/meeting/(\\d{13})-([a-z0-9-]+?)/(\\d{13})-\\2-r(\\d{1,2})-[a-z0-9-]+",
    "g"
  )
  const byNo = new Map<number, string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const meetingMs = Number(m[1])
    const slug = m[2]
    const raceNo = Number(m[4])
    if (slug !== venueSlug) continue
    if (ymd) {
      const d = new Date(meetingMs)
      const meetingYmd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
        d.getUTCDate()
      ).padStart(2, "0")}`
      if (meetingYmd !== ymd) continue
    }
    if (!byNo.has(raceNo)) byNo.set(raceNo, "https://stake.com" + m[0])
  }
  return Array.from(byNo.entries())
    .map(([raceNo, url]) => ({ raceNo, url }))
    .sort((a, b) => a.raceNo - b.raceNo)
}

// ── HTML → text lines ───────────────────────────────────────────────────────
function htmlToText(html: string): string[] {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}

// ── Race page parsing (structure verified against live Stake HTML) ──────────
interface Tip {
  rank: number
  no: number | null
  name: string
  draw: number | null
  odds: number | null
}
interface Runner {
  no: number | null
  name: string
  draw: number | null
  weight: number | null
  jockey: string | null
  trainer: string | null
  form: string | null
  op: number | null
  win: number | null
  place: number | null
  runStyle: string | null
}
interface Race {
  raceNo: number
  url: string
  title: string | null
  tips: Tip[]
  tipsComment: string | null
  runners: Runner[]
}

const RUN_STYLES = new Set([
  "Leader", "Pace", "Off-Pace", "Backmarker", "Midfield", "Off-Midfield", "No Data",
])

const nameDrawRe = /^(.+?)\s*\((\d{1,2})\)$/
const plainNumRe = /^(\d+(?:\.\d+)?)$/
const oddsNumRe = /^(?:OP\s*)?(\d+(?:\.\d+)?)$/
const kgRe = /^(\d+(?:\.\d+)?)\s*kg$/i
const indexRe = /^(\d{1,2})\.$/

// title from the race-name slug: "...-r3-hku-faculties-...-hcp-c4" → readable
function titleFromUrl(url: string, raceNo: number): string {
  const m = url.match(new RegExp(`-r${raceNo}-([a-z0-9-]+)$`))
  if (!m) return `Race ${raceNo}`
  return m[1]
    .split("-")
    .map((w) => (/^c\d+$/i.test(w) ? `(${w.toUpperCase()})` : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
}

function parseTips(lines: string[], runnersIdx: number): { tips: Tip[]; comment: string | null } {
  const ti = lines.findIndex((l) => /^Tips$/i.test(l))
  if (ti < 0) return { tips: [], comment: null }
  const end = runnersIdx > ti ? runnersIdx : Math.min(lines.length, ti + 60)
  const seg = lines.slice(ti + 1, end)
  const tips: Tip[] = []
  for (let i = 0; i < seg.length; i++) {
    const m = seg[i].match(indexRe)
    const nd = seg[i + 1]?.match(nameDrawRe)
    if (m && nd) {
      let odds: number | null = null
      for (let j = i + 2; j < Math.min(i + 5, seg.length); j++) {
        const om = seg[j].match(plainNumRe)
        if (om) { odds = Number(om[1]); break }
      }
      tips.push({ rank: tips.length + 1, no: Number(m[1]), name: nd[1], draw: Number(nd[2]), odds })
      if (tips.length >= 6) break
    }
  }
  const comment =
    seg.filter((l) => l.length > 50 && !/^\d/.test(l)).sort((a, b) => b.length - a.length)[0] || null
  return { tips, comment }
}

function parseRunners(lines: string[], runnersIdx: number): Runner[] {
  const start = runnersIdx >= 0 ? runnersIdx + 1 : 0
  // locate each runner block start: "<n>." followed by "Name (draw)"
  const starts: number[] = []
  for (let i = start; i < lines.length; i++) {
    if (indexRe.test(lines[i]) && nameDrawRe.test(lines[i + 1] || "")) starts.push(i)
  }
  const runners: Runner[] = []
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k]
    const e = k + 1 < starts.length ? starts[k + 1] : Math.min(lines.length, s + 40)
    const block = lines.slice(s, e)
    const noM = block[0].match(indexRe)
    const nd = block[1].match(nameDrawRe)
    if (!noM || !nd) continue
    const odds: number[] = []
    let weight: number | null = null
    let jockey: string | null = null
    let trainer: string | null = null
    let form: string | null = null
    let runStyle: string | null = null
    for (let i = 2; i < block.length; i++) {
      const l = block[i]
      if (l === "W") { const w = (block[i + 1] || "").match(kgRe); if (w) weight = Number(w[1]); continue }
      if (l === "J") { jockey = block[i + 1] || null; continue }
      if (l === "T") { trainer = block[i + 1] || null; continue }
      if (l === "F") { form = block[i + 1] || null; continue }
      if (RUN_STYLES.has(l)) { runStyle = l; continue }
      const wkg = l.match(kgRe); if (wkg) { weight = Number(wkg[1]); continue }
      const om = l.match(oddsNumRe); if (om) odds.push(Number(om[1]))
    }
    // odds order on page: [OP, …history…, WIN, PLACE] → win = 2nd-last, place = last
    const op = odds.length ? odds[0] : null
    const win = odds.length >= 2 ? odds[odds.length - 2] : odds.length === 1 ? odds[0] : null
    const place = odds.length >= 2 ? odds[odds.length - 1] : null
    runners.push({
      no: Number(noM[1]), name: nd[1], draw: Number(nd[2]),
      weight, jockey, trainer, form, op, win, place, runStyle,
    })
  }
  return runners
}

function parseRace(html: string, link: RaceLink): Race {
  const lines = htmlToText(html)
  const runnersIdx = lines.findIndex((l) => /^Runners?$/i.test(l))
  const { tips, comment } = parseTips(lines, runnersIdx)
  const runners = parseRunners(lines, runnersIdx)
  return {
    raceNo: link.raceNo,
    url: link.url,
    title: titleFromUrl(link.url, link.raceNo),
    tips,
    tipsComment: comment,
    runners,
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams
  const date = sp.get("date")
  const venue = (sp.get("venue") || "ST").toUpperCase()
  const venueSlug = VENUE_SLUG[venue]

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date (YYYY-MM-DD) required" }, { status: 400 })
  }
  if (!venueSlug) {
    return NextResponse.json({ error: `unknown venue: ${venue}` }, { status: 400 })
  }

  // 1) discover races. Primary = the exact-date calendar page (date-scoped, so
  //    we trust every venue-matching race on it). Fall back to today/tomorrow.
  const primary = await fetchHtml(`${BASE}/calendar/${date}`)
  let geoBlocked = false
  let links: RaceLink[] = []
  if (primary) {
    if (looksGeoBlocked(primary)) geoBlocked = true
    links = discoverRaces(primary, venueSlug, null)
  }
  if (!links.length) {
    const alts = await Promise.allSettled(
      [`${BASE}/calendar/today`, `${BASE}/calendar/tomorrow`].map((u) => fetchHtml(u))
    )
    for (const res of alts) {
      if (res.status === "fulfilled" && res.value) {
        if (looksGeoBlocked(res.value)) geoBlocked = true
        const found = discoverRaces(res.value, venueSlug, date)
        const seen = new Set(links.map((l) => l.raceNo))
        for (const f of found) if (!seen.has(f.raceNo)) links.push(f)
      }
    }
    links.sort((a, b) => a.raceNo - b.raceNo)
  }

  if (!links.length) {
    return NextResponse.json({
      date, venue, source: "stake", discovered: 0, races: [],
      error: geoBlocked ? "geo_blocked" : "no_meeting_found",
      note: geoBlocked
        ? "Stake returned its geo-restricted page, so this function is still running " +
          "from a blocked region (e.g. the US). Set the Vercel function region to Hong " +
          "Kong (hkg1): Project Settings → Functions → Region. The Hobby plan allows one " +
          "region; the preferredRegion='hkg1' in code should also apply on redeploy."
        : "No " + venue + " meeting found on Stake for " + date + ". The card may not be " +
          "posted yet (Stake usually lists HK meetings the day before).",
    })
  }

  // 2) fetch + parse each race page, chunked to bound concurrency
  const races: Race[] = []
  const chunkSize = 4
  for (let i = 0; i < links.length; i += chunkSize) {
    const chunk = links.slice(i, i + chunkSize)
    const htmls = await Promise.allSettled(chunk.map((l) => fetchHtml(l.url)))
    htmls.forEach((res, idx) => {
      const link = chunk[idx]
      if (res.status === "fulfilled" && res.value) {
        races.push(parseRace(res.value, link))
      } else {
        races.push({
          raceNo: link.raceNo, url: link.url, title: titleFromUrl(link.url, link.raceNo),
          tips: [], tipsComment: null, runners: [],
        })
      }
    })
  }
  races.sort((a, b) => a.raceNo - b.raceNo)

  return NextResponse.json({ date, venue, source: "stake", discovered: links.length, races })
}
