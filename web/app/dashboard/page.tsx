"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  ResponsiveContainer, ReferenceLine,
} from "recharts"
import {
  TrophyIcon, StarFilledIcon, ChartIcon, TableIcon, AlertIcon,
  RefreshIcon, LogoutIcon, CalendarIcon, FilterIcon, CheckIcon,
  TargetIcon, LayersIcon, SpinnerIcon,
} from "../components/icons"

// ── Types ──────────────────────────────────────────────────────────────────

interface Horse {
  name: string
  name_ch: string | null
  draw: number | null
  jockey: string | null
  jockey_ch: string | null
  trainer_ch: string | null
  win_prob: number
  win_odds: number | null
  expected_value: number | null
  should_bet: boolean
  bet_fraction: number | null  // % of bankroll already multiplied by 100
}

interface QplBet {
  horse_a: string
  horse_b: string
  qpl_prob: number
  market_odds: number | null
  ev: number | null
  should_bet: boolean
  bet_fraction: number | null
}

interface Race {
  race_no: number
  race_class: string
  distance: number | null
  going: string
  course: string
  horses: Horse[]
  best_bet: string | null
  qpl_bets: QplBet[]
}

interface PredictionResult {
  date: string
  venue: string
  races: Race[]
  message?: string
}

type SortKey = "model" | "win" | "ev"

// ── Helpers ────────────────────────────────────────────────────────────────

const API = "/api"

// Chart / accent palette (matches globals.css tokens)
const C = {
  accent: "#2ee6a6",
  accentDim: "#14c98b",
  info: "#5b9dff",
  purple: "#b78cff",
  danger: "#ff6b6b",
  grid: "#232834",
  axis: "#646d7c",
  axisLabel: "#9aa3b2",
}

async function apiFetch(path: string) {
  const res = await fetch(API + path)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(body || `HTTP ${res.status}`)
  }
  return res.json()
}

function pct(v: number) {
  return (v * 100).toFixed(1) + "%"
}

function evColor(ev: number | null) {
  if (ev === null) return "text-ink-dim"
  if (ev > 0) return "text-accent"
  return "text-danger"
}

// ── Sub-components ─────────────────────────────────────────────────────────

function RaceChart({ race }: { race: Race }) {
  const sorted = [...race.horses].sort((a, b) => b.win_prob - a.win_prob)
  const chartH = sorted.length * 38 + 30

  const probData = sorted.map(h => ({
    name: h.name_ch || h.name,
    prob: parseFloat((h.win_prob * 100).toFixed(1)),
    isBest: h.name === race.best_bet,
  }))

  const evData = sorted
    .filter(h => h.expected_value !== null)
    .map(h => ({
      name: h.name_ch || h.name,
      ev: parseFloat(h.expected_value!.toFixed(3)),
      isBest: h.name === race.best_bet,
    }))

  const tooltipStyle = {
    background: "#0d1016", border: "1px solid #232834", borderRadius: 10,
    boxShadow: "0 12px 30px -12px rgba(0,0,0,0.6)",
  }

  return (
    <div className="px-4 pt-4 pb-5 space-y-6 border-t border-line-soft bg-bg/40">
      {/* Win Probability */}
      <div>
        <p className="text-[11px] text-ink-muted uppercase tracking-wider mb-3 font-semibold">
          Win Probability
        </p>
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={probData} layout="vertical"
            margin={{ left: 0, right: 52, top: 2, bottom: 0 }}>
            <XAxis type="number"
              domain={[0, Math.max(...probData.map(d => d.prob)) * 1.2]}
              tick={{ fill: C.axis, fontSize: 10 }}
              tickFormatter={v => `${v}%`} />
            <YAxis type="category" dataKey="name" width={95}
              tick={{ fill: C.axisLabel, fontSize: 12 }} />
            <Tooltip formatter={(v) => [`${v}%`, "Win Prob"]}
              contentStyle={tooltipStyle} labelStyle={{ color: "#e8eaed" }}
              cursor={{ fill: "rgba(255,255,255,0.03)" }} />
            <Bar dataKey="prob" radius={[0, 4, 4, 0]}
              label={{ position: "right", fill: C.axisLabel, fontSize: 11,
                formatter: (v: unknown) => `${v}%` }}>
              {probData.map((e, i) => (
                <Cell key={i} fill={e.isBest ? C.accent : C.info} fillOpacity={e.isBest ? 1 : 0.8} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Expected Value (only when odds are published) */}
      {evData.length > 0 && (
        <div>
          <p className="text-[11px] text-ink-muted uppercase tracking-wider mb-3 font-semibold">
            Expected Value
          </p>
          <ResponsiveContainer width="100%" height={chartH}>
            <BarChart data={evData} layout="vertical"
              margin={{ left: 0, right: 52, top: 2, bottom: 0 }}>
              <XAxis type="number" tick={{ fill: C.axis, fontSize: 10 }}
                tickFormatter={v => v > 0 ? `+${v}` : `${v}`} />
              <YAxis type="category" dataKey="name" width={95}
                tick={{ fill: C.axisLabel, fontSize: 12 }} />
              <ReferenceLine x={0} stroke="#3a4250" />
              <Tooltip
                formatter={(v) => [typeof v === "number" ? (v >= 0 ? `+${v.toFixed(3)}` : v.toFixed(3)) : v, "EV"]}
                contentStyle={tooltipStyle} labelStyle={{ color: "#e8eaed" }}
                cursor={{ fill: "rgba(255,255,255,0.03)" }} />
              <Bar dataKey="ev" radius={[0, 4, 4, 0]}
                label={{ position: "right", fill: C.axisLabel, fontSize: 11,
                  formatter: (v: unknown) => typeof v === "number" ? (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)) : "" }}>
                {evData.map((e, i) => (
                  <Cell key={i} fill={e.ev > 0 ? C.accent : C.danger} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

function ProbBar({ value, best }: { value: number; best?: boolean }) {
  const width = Math.round(value * 100)
  return (
    <div className="flex items-center gap-2 min-w-[96px]">
      <div className="flex-1 bg-bg rounded-full h-1.5 overflow-hidden">
        <div
          className="h-1.5 rounded-full transition-all"
          style={{
            width: `${Math.min(width, 100)}%`,
            background: best
              ? "linear-gradient(90deg, #14c98b, #2ee6a6)"
              : "#5b9dff",
          }}
        />
      </div>
      <span className="text-xs font-mono w-11 text-right text-ink">{pct(value)}</span>
    </div>
  )
}

function RaceCard({ race }: { race: Race }) {
  const [showChart, setShowChart] = useState(false)
  const [sort, setSort] = useState<SortKey>("model")
  const hasBet = race.best_bet !== null
  const oddsAvailable = race.horses.some((h) => h.win_odds !== null)

  const horses = useMemo(() => {
    const arr = [...race.horses]
    if (sort === "win") arr.sort((a, b) => b.win_prob - a.win_prob)
    else if (sort === "ev") arr.sort((a, b) => (b.expected_value ?? -Infinity) - (a.expected_value ?? -Infinity))
    return arr
  }, [race.horses, sort])

  return (
    <div className={[
      "surface-card overflow-hidden transition-shadow",
      hasBet ? "ring-1 ring-accent/20" : "",
    ].join(" ")}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line-soft bg-surface-2/60">
        <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
          <span className="inline-flex items-center justify-center min-w-[2rem] h-7 px-2 rounded-lg bg-bg border border-line text-ink font-semibold text-sm">
            R{race.race_no}
          </span>
          {race.race_class && (
            <span className="chip">{race.race_class}</span>
          )}
          {race.distance && (
            <span className="text-ink-muted text-xs">{race.distance}m</span>
          )}
          {race.going && (
            <span className="text-ink-dim text-xs">· {race.going}</span>
          )}
          {race.course && (
            <span className="text-ink-dim text-xs hidden sm:inline">· {race.course}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowChart(v => !v)}
            className={[
              "inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors",
              showChart
                ? "bg-info/15 border-info/40 text-info"
                : "bg-bg border-line text-ink-muted hover:text-ink hover:border-line",
            ].join(" ")}
          >
            {showChart ? <TableIcon className="text-sm" /> : <ChartIcon className="text-sm" />}
            <span className="hidden sm:inline">{showChart ? "Table" : "Chart"}</span>
          </button>
          {hasBet ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-accent/15 text-accent border border-accent/30">
              <TargetIcon className="text-sm" /> BET
            </span>
          ) : (
            <span className="text-ink-dim text-xs px-1">No bet</span>
          )}
        </div>
      </div>

      {/* Sort controls (table view only) */}
      {!showChart && (
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-line-soft text-[11px] text-ink-dim">
          <span className="uppercase tracking-wider mr-1">Sort</span>
          {([
            ["model", "Model rank"],
            ["win", "Win %"],
            ...(oddsAvailable ? [["ev", "EV"] as [SortKey, string]] : []),
          ] as [SortKey, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSort(key)}
              className={[
                "px-2 py-0.5 rounded-md transition-colors",
                sort === key
                  ? "bg-surface-2 text-ink border border-line"
                  : "text-ink-muted hover:text-ink border border-transparent",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Chart view */}
      {showChart && <RaceChart race={race} />}

      {/* Table view */}
      {!showChart && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-soft text-ink-dim text-[11px] uppercase tracking-wider">
                <th className="text-left px-4 py-2 font-medium">Horse</th>
                <th className="text-center px-2 py-2 font-medium hidden sm:table-cell">Draw</th>
                <th className="text-center px-2 py-2 font-medium hidden md:table-cell">Jockey</th>
                <th className="px-4 py-2 font-medium">Win %</th>
                <th className="text-center px-2 py-2 font-medium">Odds</th>
                {oddsAvailable && (
                  <>
                    <th className="text-center px-2 py-2 font-medium">EV</th>
                    <th className="text-center px-2 py-2 font-medium hidden sm:table-cell">Stake</th>
                    <th className="text-center px-2 py-2 font-medium">Bet?</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {horses.map((horse) => {
                const isBest = horse.name === race.best_bet
                return (
                  <tr
                    key={horse.name}
                    className={[
                      "border-b border-line-soft/60 transition-colors",
                      isBest
                        ? "bg-accent/[0.07] hover:bg-accent/[0.1]"
                        : "hover:bg-surface-2/50",
                    ].join(" ")}
                  >
                    <td className="px-4 py-2.5 font-medium text-ink">
                      <div className="flex items-center gap-2">
                        {isBest && (
                          <StarFilledIcon className="text-accent text-sm shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate">{horse.name}</div>
                          {horse.name_ch && (
                            <div className="text-ink-dim text-xs font-normal truncate">{horse.name_ch}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="text-center px-2 py-2.5 text-ink-muted hidden sm:table-cell">
                      {horse.draw ?? "—"}
                    </td>
                    <td className="text-center px-2 py-2.5 text-xs hidden md:table-cell">
                      {horse.jockey_ch || horse.jockey
                        ? (
                          <div>
                            {horse.jockey_ch && <div className="text-ink-muted">{horse.jockey_ch}</div>}
                            {horse.jockey && <div className="text-ink-dim">{horse.jockey}</div>}
                          </div>
                        )
                        : <span className="text-ink-dim">—</span>
                      }
                    </td>
                    <td className="px-4 py-2.5">
                      <ProbBar value={horse.win_prob} best={isBest} />
                    </td>
                    <td className="text-center px-2 py-2.5 text-ink-muted">
                      {horse.win_odds != null ? horse.win_odds.toFixed(1) : (
                        <span className="text-ink-dim">—</span>
                      )}
                    </td>
                    {oddsAvailable && (
                      <>
                        <td className={`text-center px-2 py-2.5 font-mono text-xs ${evColor(horse.expected_value)}`}>
                          {horse.expected_value != null
                            ? (horse.expected_value >= 0 ? "+" : "") + horse.expected_value.toFixed(3)
                            : "—"}
                        </td>
                        <td className="text-center px-2 py-2.5 text-ink-muted font-mono text-xs hidden sm:table-cell">
                          {horse.bet_fraction != null && horse.bet_fraction > 0
                            ? horse.bet_fraction.toFixed(1) + "%"
                            : "—"}
                        </td>
                        <td className="text-center px-2 py-2.5">
                          {horse.should_bet ? (
                            <span className="inline-flex items-center gap-1 bg-accent/15 text-accent border border-accent/30 text-[11px] font-bold px-2 py-0.5 rounded-md">
                              <CheckIcon className="text-xs" /> BET
                            </span>
                          ) : (
                            <span className="text-ink-dim text-xs">—</span>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Best bet callout */}
      {hasBet && (() => {
        const best = race.horses.find((h) => h.name === race.best_bet)
        if (!best) return null
        return (
          <div className="px-4 py-3 bg-accent/[0.06] border-t border-accent/15 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-accent font-semibold">
                <StarFilledIcon className="text-sm shrink-0" /> {best.name}
              </span>
              {best.name_ch && (
                <span className="text-accent-strong text-sm ml-1.5">{best.name_ch}</span>
              )}
              <div className="text-ink-muted text-xs mt-0.5">
                {pct(best.win_prob)} win probability
                {best.win_odds != null && ` · odds ${best.win_odds.toFixed(1)}`}
                {best.expected_value != null && ` · EV ${best.expected_value >= 0 ? "+" : ""}${best.expected_value.toFixed(3)}`}
              </div>
            </div>
            {best.bet_fraction != null && best.bet_fraction > 0 && (
              <div className="text-right shrink-0">
                <span className="text-accent font-bold text-lg leading-none">{best.bet_fraction.toFixed(1)}%</span>
                <p className="text-ink-dim text-[11px] mt-0.5">of bankroll</p>
              </div>
            )}
          </div>
        )
      })()}

      {/* Odds not yet available notice */}
      {!oddsAvailable && (
        <div className="px-4 py-2 bg-warn/[0.06] border-t border-warn/15 text-warn/90 text-xs flex items-center gap-1.5">
          <AlertIcon className="text-sm shrink-0" />
          Odds not yet published — probabilities only. Re-fetch once HKJC posts odds.
        </div>
      )}

      {/* QPL section */}
      {race.qpl_bets && race.qpl_bets.length > 0 && (
        <div className="border-t border-line-soft px-4 py-3">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-brand uppercase tracking-wider">
              <LayersIcon className="text-sm" /> Quinella Place
            </span>
            {!race.qpl_bets[0].market_odds && (
              <span className="text-[11px] text-ink-dim italic">
                Ranked by Harville probability — market odds not yet available
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            {race.qpl_bets.map((qb, i) => (
              <div
                key={i}
                className={[
                  "flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm",
                  qb.should_bet
                    ? "bg-brand/[0.1] border border-brand/30"
                    : "bg-surface-2/50 border border-transparent",
                ].join(" ")}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {qb.should_bet && <StarFilledIcon className="text-brand text-xs shrink-0" />}
                  <span className="font-medium text-ink truncate">{qb.horse_a}</span>
                  <span className="text-ink-dim text-xs">+</span>
                  <span className="font-medium text-ink truncate">{qb.horse_b}</span>
                </div>
                <div className="flex items-center gap-3 text-xs font-mono shrink-0">
                  <span className="text-ink-muted">
                    {(qb.qpl_prob * 100).toFixed(1)}%
                  </span>
                  {qb.market_odds != null && (
                    <span className="text-ink-muted">@{qb.market_odds.toFixed(1)}</span>
                  )}
                  {qb.ev != null && (
                    <span className={qb.ev >= 0 ? "text-accent" : "text-danger"}>
                      {qb.ev >= 0 ? "+" : ""}{qb.ev.toFixed(3)}
                    </span>
                  )}
                  {qb.should_bet && qb.bet_fraction != null && (
                    <span className="bg-brand/20 text-brand border border-brand/30 px-2 py-0.5 rounded font-bold whitespace-nowrap">
                      {qb.bet_fraction.toFixed(1)}%
                    </span>
                  )}
                  {!qb.should_bet && qb.market_odds != null && (
                    <span className="text-ink-dim">—</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "accent" | "brand" | "warn" }) {
  const toneClass =
    tone === "accent" ? "text-accent" :
    tone === "brand" ? "text-brand" :
    tone === "warn" ? "text-warn" : "text-ink"
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wider text-ink-dim">{label}</span>
      <span className={`text-lg font-semibold leading-tight mt-0.5 ${toneClass}`}>{value}</span>
    </div>
  )
}

// ── Main dashboard ─────────────────────────────────────────────────────────

export default function Dashboard() {
  const router = useRouter()

  const [meetingDate, setMeetingDate] = useState("")
  const [venue, setVenue] = useState("ST")
  const [result, setResult] = useState<PredictionResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState("")
  const [error, setError] = useState("")
  const [lastFetched, setLastFetched] = useState<string | null>(null)
  const [betsOnly, setBetsOnly] = useState(false)

  // Auto-detect next meeting on mount
  useEffect(() => {
    apiFetch("/next-meeting")
      .then((data) => {
        if (data.date) {
          setMeetingDate(data.date)
          setVenue(data.venue)
        }
      })
      .catch(() => {})
  }, [])

  const fetchPredictions = useCallback(async () => {
    if (!meetingDate) return
    setLoading(true)
    setError("")
    setStatus("Waking up prediction server…")

    // Poll /api/wake until Render is ready (cold start can take 60-90s)
    let ready = false
    for (let i = 0; i < 24 && !ready; i++) {
      try {
        const res = await fetch("/api/wake")
        const data = await res.json()
        if (data.ready) { ready = true; break }
      } catch {}
      setStatus(`Server warming up… ${(i + 1) * 5}s elapsed (may take up to 90s)`)
      await new Promise(r => setTimeout(r, 5000))
    }

    if (!ready) {
      setError("Server failed to wake up. Please try again in a minute.")
      setLoading(false)
      setStatus("")
      return
    }

    setStatus("Server ready — fetching predictions…")
    try {
      const data: PredictionResult = await apiFetch(
        `/predict?meeting_date=${meetingDate}&venue=${venue}`
      )
      setResult(data)
      setLastFetched(new Date().toLocaleTimeString())
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setStatus("")
    }
  }, [meetingDate, venue])

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" })
    router.push("/")
  }

  const betsTotal = result?.races.filter((r) => r.best_bet !== null).length ?? 0
  const qplTotal = result?.races.reduce((acc, r) => acc + (r.qpl_bets?.filter(q => q.should_bet).length ?? 0), 0) ?? 0
  const oddsReady = result?.races.some((r) =>
    r.horses.some((h) => h.win_odds !== null)
  ) ?? false

  const visibleRaces = useMemo(() => {
    if (!result) return []
    if (!betsOnly) return result.races
    return result.races.filter(
      (r) => r.best_bet !== null || (r.qpl_bets?.some((q) => q.should_bet) ?? false)
    )
  }, [result, betsOnly])

  return (
    <div className="min-h-screen">
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 bg-surface/85 backdrop-blur-md border-b border-line">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
          <span className="text-base font-semibold text-ink flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-surface-2 border border-line text-accent">
              <TrophyIcon className="text-base" />
            </span>
            HKJC Predictor
          </span>

          <div className="flex items-center gap-2 ml-1">
            <div className="relative">
              <CalendarIcon className="text-sm text-ink-dim absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="date"
                value={meetingDate}
                onChange={(e) => setMeetingDate(e.target.value)}
                className="field pl-8 pr-3 py-1.5 text-sm"
              />
            </div>
            <select
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              className="field px-3 py-1.5 text-sm cursor-pointer"
            >
              <option value="ST">Sha Tin (ST)</option>
              <option value="HV">Happy Valley (HV)</option>
            </select>
          </div>

          <button
            onClick={fetchPredictions}
            disabled={loading || !meetingDate}
            className="btn-accent px-4 py-1.5 text-sm flex items-center gap-2"
          >
            {loading ? (
              <>
                <SpinnerIcon className="text-base animate-spin-smooth" />
                <span className="max-w-[180px] truncate">{status || "Fetching…"}</span>
              </>
            ) : (
              <>
                <RefreshIcon className="text-base" /> Fetch
              </>
            )}
          </button>

          <div className="ml-auto flex items-center gap-3">
            {lastFetched && (
              <span className="text-ink-dim text-xs hidden sm:block">
                Updated {lastFetched}
              </span>
            )}
            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 text-ink-muted hover:text-ink text-sm transition-colors"
            >
              <LogoutIcon className="text-base" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────────────────── */}
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        {/* Summary bar */}
        {result && (
          <div className="surface-card px-5 py-4 flex flex-wrap items-center gap-x-8 gap-y-4 animate-fade-up">
            <StatCard
              label="Meeting"
              value={<span className="text-sm">{result.date} · {result.venue}</span>}
            />
            <StatCard label="Races" value={result.races.length} />
            <StatCard label="Win bets" value={betsTotal} tone={betsTotal > 0 ? "accent" : undefined} />
            <StatCard label="QPL bets" value={qplTotal > 0 ? qplTotal : "—"} tone={qplTotal > 0 ? "brand" : undefined} />

            <div className="ml-auto flex items-center gap-3">
              {!oddsReady && (
                <span className="chip text-warn border-warn/30">
                  <AlertIcon className="text-sm" /> Odds pending
                </span>
              )}
              <button
                onClick={() => setBetsOnly((v) => !v)}
                className={[
                  "inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors",
                  betsOnly
                    ? "bg-accent/15 border-accent/30 text-accent"
                    : "bg-bg border-line text-ink-muted hover:text-ink",
                ].join(" ")}
              >
                <FilterIcon className="text-sm" />
                {betsOnly ? "Bets only" : "All races"}
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="surface-card border-danger/30 bg-danger/[0.06] text-danger px-4 py-3 text-sm flex items-center gap-2">
            <AlertIcon className="text-base shrink-0" /> {error}
          </div>
        )}

        {/* Empty state */}
        {!result && !loading && !error && (
          <div className="text-center py-24 animate-fade-up">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-2 border border-line text-accent mb-5">
              <TrophyIcon className="text-3xl" />
            </div>
            <p className="text-lg text-ink">
              Select a date and click <strong className="text-accent font-semibold">Fetch</strong>
            </p>
            <p className="text-sm mt-1.5 text-ink-muted">
              Race cards are usually published the day before the meeting.
            </p>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && !result && (
          <div className="text-center py-24 text-ink-muted animate-fade-up">
            <SpinnerIcon className="text-4xl text-accent animate-spin-smooth mx-auto mb-4" />
            <p className="text-sm">{status || "Loading…"}</p>
          </div>
        )}

        {/* Message from API (e.g. no races found) */}
        {result?.message && (
          <div className="surface-card border-warn/25 bg-warn/[0.06] text-warn px-4 py-3 text-sm flex items-center gap-2">
            <AlertIcon className="text-base shrink-0" /> {result.message}
          </div>
        )}

        {/* Bets-only empty */}
        {result && betsOnly && visibleRaces.length === 0 && (
          <div className="text-center py-16 text-ink-muted">
            No qualifying bets in this meeting. Toggle back to <strong className="text-ink">All races</strong> to view every card.
          </div>
        )}

        {/* Race cards */}
        <div className="space-y-4">
          {visibleRaces.map((race) => (
            <RaceCard key={race.race_no} race={race} />
          ))}
        </div>
      </main>
    </div>
  )
}
