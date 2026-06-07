import { NextRequest, NextResponse } from "next/server"

// Stake geo-blocks US IPs (returns a "restrictedRegion" modal with no data).
// Vercel's default region is iad1 (US), so we MUST pin this route to Asian
// regions or every scrape comes back empty.
export const preferredRegion = ["sin1", "hkg1"]
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

function fetchHtml(url: string, timeoutMs = 20_000): Promise<string | null> {
  return fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
    },
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  })
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null)
}

// ---------- meeting discovery ----------
// A meeting race URL looks like:
//   /sports/racing/horse-racing/asia/meeting/{meetingMs}-{slug}/{raceMs}-{slug}-r{N}-{name}-{class}
// meetingMs is R1 post time in epoch ms; its UTC date == the HK meeting date.
interface RaceLink {
  raceNo: number
  url: string
}

function discoverRaces(html: string, venueSlug: string, ymd: string): RaceLink[] {
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
    const d = new Date(meetingMs)
    const meetingYmd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
      d.getUTCDate()
    ).padStart(2, "0")}`
    if (meetingYmd !== ymd) continue
    const full = "https://stake.com" + m[0]
    if (!byNo.has(raceNo)) byNo.set(raceNo, full)
  }
  return Array.from(byNo.entries())
    .map(([raceNo, url]) => ({ raceNo, url }))
    .sort((a, b) => a.raceNo - b.raceNo)
}

// ---------- html -> text ----------
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

// ---------- race page parsing ----------
interface Tip {
  rank: number
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
  "Leader",
  "Pace",
  "Off-Pace",
  "Backmarker",
  "Midfield",
  "Off-Midfield",
  "No Data",
])

const numRe = /^(?:OP\s*)?(\d+(?:\.\d+)?)$/
const nameDrawRe = /^(.+?)\s*\((\d{1,2})\)$/

function parseRace(lines: string[], link: RaceLink): Race {
  let title: string | null = null
  for (const l of lines) {
    if (/-r\d+-/i.test(l)) continue
    if (/\b(HCP|Hcp|Class \d|Group \d|Griffin|Maiden|Cup|Plate|Handicap)\b/.test(l)) {
      title = l
      break
    }
  }

  // tips: after a "Tips" header, look for ranked lines like "1." then "Name (draw)"
  const tips: Tip[] = []
  let tipsComment: string | null = null
  const tipsIdx = lines.findIndex((l) => /^Tips?$/i.test(l))
  if (tipsIdx >= 0) {
    const end = Math.min(lines.length, tipsIdx + 60)
    for (let i = tipsIdx + 1; i < end; i++) {
      const rm = lines[i].match(/^(\d)\.$/)
      if (rm) {
        const rank = Number(rm[1])
        let name = ""
        let draw: number | null = null
        let odds: number | null = null
        // next non-empty line should hold the name (maybe with draw)
        const nd = lines[i + 1]?.match(nameDrawRe)
        if (nd) {
          name = nd[1]
          draw = Number(nd[2])
        } else if (lines[i + 1]) {
          name = lines[i + 1]
        }
        // scan a couple of lines ahead for an odds number
        for (let j = i + 2; j < Math.min(i + 5, lines.length); j++) {
          const om = lines[j]?.match(numRe)
          if (om) {
            odds = Number(om[1])
            break
          }
        }
        if (name) tips.push({ rank, name, draw, odds })
        if (tips.length >= 4) break
      }
    }
    // commentary: longest plain line in the tips block
    const block = lines.slice(tipsIdx + 1, end).filter((l) => l.length > 40 && !numRe.test(l))
    if (block.length) tipsComment = block.sort((a, b) => b.length - a.length)[0]
  }

  // runners
  const runners: Runner[] = []
  const runnersIdx = lines.findIndex((l) => /^Runners?$/i.test(l))
  const startScan = runnersIdx >= 0 ? runnersIdx + 1 : 0
  let cur: Runner | null = null
  const flush = () => {
    if (cur && cur.name) runners.push(cur)
    cur = null
  }
  for (let i = startScan; i < lines.length; i++) {
    const l = lines[i]
    // a runner block begins with "<no>." followed by "Name (draw)"
    const noM = l.match(/^(\d{1,2})\.$/)
    const nd = lines[i + 1]?.match(nameDrawRe)
    if (noM && nd) {
      flush()
      cur = {
        no: Number(noM[1]),
        name: nd[1],
        draw: Number(nd[2]),
        weight: null,
        jockey: null,
        trainer: null,
        form: null,
        op: null,
        win: null,
        place: null,
        runStyle: null,
      }
      i += 1
      continue
    }
    if (!cur) continue
    const wM = l.match(/^(\d+(?:\.\d+)?)\s*kg$/i)
    if (wM) {
      cur.weight = Number(wM[1])
      continue
    }
    if (RUN_STYLES.has(l)) {
      cur.runStyle = l
      continue
    }
    if (/^J:/.test(l)) {
      cur.jockey = l.replace(/^J:\s*/, "")
      continue
    }
    if (/^T:/.test(l)) {
      cur.trainer = l.replace(/^T:\s*/, "")
      continue
    }
    if (/^F:/.test(l)) {
      cur.form = l.replace(/^F:\s*/, "")
      continue
    }
    const om = l.match(numRe)
    if (om) {
      const v = Number(om[1])
      if (cur.op == null && /^OP/.test(l)) cur.op = v
      // collect into a temp array via win/place rotation: keep last two
      if (cur.win == null) cur.win = v
      else {
        cur.place = cur.win
        cur.win = v
      }
    }
  }
  flush()
  // normalize: if op captured, win/place hold the last two odds seen
  for (const r of runners) {
    if (r.place == null && r.win != null && r.op != null) {
      r.place = r.win
      r.win = r.op
    }
  }

  return { raceNo: link.raceNo, url: link.url, title, tips, tipsComment, runners }
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams
  const date = sp.get("date") // YYYY-MM-DD
  const venue = (sp.get("venue") || "ST").toUpperCase()
  const venueSlug = VENUE_SLUG[venue]

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date (YYYY-MM-DD) required" }, { status: 400 })
  }
  if (!venueSlug) {
    return NextResponse.json({ error: `unknown venue: ${venue}` }, { status: 400 })
  }

  // 1) discover the meeting's race URLs from index/calendar pages
  const indexUrls = [
    `${BASE}/calendar/today`,
    `${BASE}`,
    `${BASE}/calendar/${date}`,
  ]
  const indexHtmls = await Promise.allSettled(indexUrls.map((u) => fetchHtml(u)))
  let links: RaceLink[] = []
  for (const res of indexHtmls) {
    if (res.status === "fulfilled" && res.value) {
      const found = discoverRaces(res.value, venueSlug, date)
      if (found.length) {
        // merge unique by raceNo
        const seen = new Set(links.map((l) => l.raceNo))
        for (const f of found) if (!seen.has(f.raceNo)) links.push(f)
      }
    }
  }
  links.sort((a, b) => a.raceNo - b.raceNo)

  if (!links.length) {
    return NextResponse.json({
      date,
      venue,
      source: "stake",
      discovered: 0,
      races: [],
      error: "no_meeting_found",
      note:
        "Could not locate this meeting on Stake. Either the card isn't posted yet, " +
        "or the scrape ran from a geo-restricted region. This route is pinned to " +
        "Asian regions (sin1/hkg1); if you still see this after deploy, the meeting " +
        "may not be live on Stake yet.",
    })
  }

  // 2) fetch + parse each race page (cap concurrency by chunking)
  const races: Race[] = []
  const chunkSize = 4
  for (let i = 0; i < links.length; i += chunkSize) {
    const chunk = links.slice(i, i + chunkSize)
    const htmls = await Promise.allSettled(chunk.map((l) => fetchHtml(l.url)))
    htmls.forEach((res, idx) => {
      const link = chunk[idx]
      if (res.status === "fulfilled" && res.value) {
        races.push(parseRace(htmlToText(res.value), link))
      } else {
        races.push({
          raceNo: link.raceNo,
          url: link.url,
          title: null,
          tips: [],
          tipsComment: null,
          runners: [],
        })
      }
    })
  }
  races.sort((a, b) => a.raceNo - b.raceNo)

  return NextResponse.json({
    date,
    venue,
    source: "stake",
    discovered: links.length,
    races,
  })
}
