import { NextRequest, NextResponse } from "next/server"

// ── Region pinning ──────────────────────────────────────────────────────────
// Stake geo-blocks US IPs. Single region only on Hobby plan.
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

// ── Block detection ─────────────────────────────────────────────────────────
type BlockType = "geo" | "cloudflare" | null

function detectBlock(html: string): BlockType {
  // Cloudflare managed challenge / bot-fight mode
  if (/Just a moment\.\.\.|cf-mitigated|_cf_challenge|challenges\.cloudflare\.com/i.test(html)) {
    return "cloudflare"
  }
  // Stake geo-restriction page
  if (/restrictedRegion|not available in your (region|country)|access from your country is restricted/i.test(html)) {
    return "geo"
  }
  return null
}

// ── Meeting discovery ───────────────────────────────────────────────────────
interface RaceLink {
  raceNo: number
  url: string
}

function discoverRaces(html: string, venueSlugPrefix: string, ymd: string | null): RaceLink[] {
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
    // Flexible slug matching — slug must CONTAIN the venue keyword
    // (handles variants like "happy-valley-hk", "sha-tin-racecourse", etc.)
    if (!slug.includes(venueSlugPrefix)) continue
    if (ymd) {
      // Use HKT (UTC+8) for date comparison — HV evening meetings start at
      // ~19:00 HKT; if Stake stores the meeting timestamp as midnight HKT,
      // that's 16:00 UTC the day before, causing a UTC date mismatch.
      const hktMs = meetingMs + 8 * 60 * 60 * 1000
      const d = new Date(hktMs)
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

// ── Race page parsing ───────────────────────────────────────────────────────
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
  const venueSlugPrefix = VENUE_SLUG[venue]

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date (YYYY-MM-DD) required" }, { status: 400 })
  }
  if (!venueSlugPrefix) {
    return NextResponse.json({ error: `unknown venue: ${venue}` }, { status: 400 })
  }

  const stakeUrl = `${BASE}/calendar/${date}`
  let blockType: BlockType = null
  let links: RaceLink[] = []

  // 1) Primary: date-scoped calendar page (no date filter needed — URL is already scoped)
  const primary = await fetchHtml(`${BASE}/calendar/${date}`)
  if (primary) {
    const detected = detectBlock(primary)
    if (detected) blockType = detected
    else links = discoverRaces(primary, venueSlugPrefix, null)
  }

  // 2) Fallbacks: today, tomorrow, yesterday
  if (!links.length && blockType !== "cloudflare") {
    const fallbackUrls = [
      `${BASE}/calendar/today`,
      `${BASE}/calendar/tomorrow`,
      `${BASE}/calendar/yesterday`,
    ]
    const alts = await Promise.allSettled(fallbackUrls.map((u) => fetchHtml(u)))
    for (const res of alts) {
      if (res.status === "fulfilled" && res.value) {
        const detected = detectBlock(res.value)
        if (detected) { blockType = detected; break }
        // Use HKT-aware date filter in discoverRaces
        const found = discoverRaces(res.value, venueSlugPrefix, date)
        const seen = new Set(links.map((l) => l.raceNo))
        for (const f of found) if (!seen.has(f.raceNo)) links.push(f)
      }
    }
    links.sort((a, b) => a.raceNo - b.raceNo)
  }

  // ── Error responses ────────────────────────────────────────────────────────
  if (!links.length) {
    if (blockType === "cloudflare") {
      return NextResponse.json({
        date, venue, source: "stake", discovered: 0, races: [],
        error: "cloudflare_blocked",
        stakeUrl,
        note:
          "Stake is currently protected by Cloudflare bot detection, which blocks " +
          "server-side requests. Open the Stake page directly in your browser to see " +
          "RaceLab tips and live odds.",
      })
    }
    if (blockType === "geo") {
      return NextResponse.json({
        date, venue, source: "stake", discovered: 0, races: [],
        error: "geo_blocked",
        stakeUrl,
        note:
          "Stake returned its geo-restricted page. The Vercel function may still be " +
          "running from a US region. Ensure preferredRegion='hkg1' in stake/route.ts " +
          "and redeploy.",
      })
    }
    return NextResponse.json({
      date, venue, source: "stake", discovered: 0, races: [],
      error: "no_meeting_found",
      stakeUrl,
      note:
        "No " + venue + " meeting found on Stake for " + date +
        ". The card may not be posted yet — Stake usually lists HK meetings the day before.",
    })
  }

  // 3) Fetch + parse race pages
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

  return NextResponse.json({ date, venue, source: "stake", discovered: links.length, races, stakeUrl })
}
