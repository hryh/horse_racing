"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  ResponsiveContainer, ReferenceLine,
} from "recharts"

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

interface Race {
  race_no: number
  race_class: string
  distance: number | null
  going: string
  course: string
  horses: Horse[]
  best_bet: string | null
}

interface PredictionResult {
  date: string
  venue: string
  races: Race[]
  message?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────

const API = "/api"

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
  if (ev === null) return "text-gray-400"
  if (ev > 0) return "text-green-400"
  return "text-red-400"
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
    background: "#111827", border: "1px solid #374151", borderRadius: 8,
  }

  return (
    <div className="px-4 pt-3 pb-5 space-y-6 border-t border-gray-800 bg-gray-950/40">
      {/* Win Probability */}
      <div>
        <p className="text-xs text-gray-400 uppercase tracking-wide mb-3 font-medium">
          Win Probability
        </p>
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={probData} layout="vertical"
            margin={{ left: 0, right: 52, top: 2, bottom: 0 }}>
            <XAxis type="number"
              domain={[0, Math.max(...probData.map(d => d.prob)) * 1.2]}
              tick={{ fill: "#6b7280", fontSize: 10 }}
              tickFormatter={v => `${v}%`} />
            <YAxis type="category" dataKey="name" width={95}
              tick={{ fill: "#d1d5db", fontSize: 12 }} />
            <Tooltip formatter={(v) => [`${v}%`, "Win Prob"]}
              contentStyle={tooltipStyle} labelStyle={{ color: "#f9fafb" }} />
            <Bar dataKey="prob" radius={[0, 4, 4, 0]}
              label={{ position: "right", fill: "#9ca3af", fontSize: 11,
                formatter: (v: number) => `${v}%` }}>
              {probData.map((e, i) => (
                <Cell key={i} fill={e.isBest ? "#16a34a" : "#3b82f6"} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Expected Value (only when odds are published) */}
      {evData.length > 0 && (
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide mb-3 font-medium">
            Expected Value
          </p>
          <ResponsiveContainer width="100%" height={chartH}>
            <BarChart data={evData} layout="vertical"
              margin={{ left: 0, right: 52, top: 2, bottom: 0 }}>
              <XAxis type="number" tick={{ fill: "#6b7280", fontSize: 10 }}
                tickFormatter={v => v > 0 ? `+${v}` : `${v}`} />
              <YAxis type="category" dataKey="name" width={95}
                tick={{ fill: "#d1d5db", fontSize: 12 }} />
              <ReferenceLine x={0} stroke="#4b5563" />
              <Tooltip
                formatter={(v) => [typeof v === "number" ? (v >= 0 ? `+${v.toFixed(3)}` : v.toFixed(3)) : v, "EV"]}
                contentStyle={tooltipStyle} labelStyle={{ color: "#f9fafb" }} />
              <Bar dataKey="ev" radius={[0, 4, 4, 0]}
                label={{ position: "right", fill: "#9ca3af", fontSize: 11,
                  formatter: (v: number) => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2) }}>
                {evData.map((e, i) => (
                  <Cell key={i} fill={e.ev > 0 ? "#16a34a" : "#ef4444"} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

function ProbBar({ value }: { value: number }) {
  const width = Math.round(value * 100)
  return (
    <div className="flex items-center gap-2 min-w-[90px]">
      <div className="flex-1 bg-gray-700 rounded-full h-1.5">
        <div
          className="bg-green-500 h-1.5 rounded-full transition-all"
          style={{ width: `${Math.min(width, 100)}%` }}
        />
      </div>
      <span className="text-xs font-mono w-10 text-right">{pct(value)}</span>
    </div>
  )
}

function RaceCard({ race }: { race: Race }) {
  const [showChart, setShowChart] = useState(false)
  const hasBet = race.best_bet !== null
  const oddsAvailable = race.horses.some((h) => h.win_odds !== null)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <span className="text-white font-bold text-lg">Race {race.race_no}</span>
          {race.race_class && (
            <span className="bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded-full">
              {race.race_class}
            </span>
          )}
          {race.distance && (
            <span className="text-gray-400 text-sm">{race.distance}m</span>
          )}
          {race.going && (
            <span className="text-gray-400 text-sm">· {race.going}</span>
          )}
          {race.course && (
            <span className="text-gray-500 text-xs">· {race.course}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowChart(v => !v)}
            className={[
              "text-xs px-2.5 py-1 rounded-lg border transition-colors",
              showChart
                ? "bg-blue-800 border-blue-700 text-blue-100"
                : "bg-gray-800 border-gray-700 text-gray-400 hover:text-white",
            ].join(" ")}
          >
            📊 {showChart ? "Table" : "Chart"}
          </button>
          {hasBet ? (
            <span className="bg-green-700 text-green-100 text-xs font-semibold px-3 py-1 rounded-full">
              BET AVAILABLE
            </span>
          ) : (
            <span className="text-gray-500 text-xs">No bet</span>
          )}
        </div>
      </div>

      {/* Chart view */}
      {showChart && <RaceChart race={race} />}

      {/* Table view */}
      {!showChart && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wide">
                <th className="text-left px-4 py-2">Horse</th>
                <th className="text-center px-2 py-2">Draw</th>
                <th className="text-center px-2 py-2">Jockey</th>
                <th className="px-4 py-2">Win %</th>
                <th className="text-center px-2 py-2">Odds</th>
                {oddsAvailable && (
                  <>
                    <th className="text-center px-2 py-2">EV</th>
                    <th className="text-center px-2 py-2">Stake</th>
                  </>
                )}
                {oddsAvailable && <th className="text-center px-2 py-2">Bet?</th>}
              </tr>
            </thead>
            <tbody>
              {race.horses.map((horse) => {
                const isBest = horse.name === race.best_bet
                return (
                  <tr
                    key={horse.name}
                    className={[
                      "border-b border-gray-800/50 transition-colors",
                      isBest
                        ? "bg-green-950/60 hover:bg-green-950/80"
                        : "hover:bg-gray-800/40",
                    ].join(" ")}
                  >
                    <td className="px-4 py-2.5 font-medium text-white">
                      <div className="flex items-center gap-2">
                        {isBest && (
                          <span className="text-green-400 text-base">★</span>
                        )}
                        <div>
                          <div>{horse.name}</div>
                          {horse.name_ch && (
                            <div className="text-gray-400 text-xs font-normal">{horse.name_ch}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="text-center px-2 py-2.5 text-gray-300">
                      {horse.draw ?? "—"}
                    </td>
                    <td className="text-center px-2 py-2.5 text-xs">
                      {horse.jockey_ch || horse.jockey
                        ? (
                          <div>
                            {horse.jockey_ch && <div className="text-gray-300">{horse.jockey_ch}</div>}
                            {horse.jockey && <div className="text-gray-500">{horse.jockey}</div>}
                          </div>
                        )
                        : <span className="text-gray-600">—</span>
                      }
                    </td>
                    <td className="px-4 py-2.5">
                      <ProbBar value={horse.win_prob} />
                    </td>
                    <td className="text-center px-2 py-2.5 text-gray-300">
                      {horse.win_odds != null ? horse.win_odds.toFixed(1) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    {oddsAvailable && (
                      <>
                        <td className={`text-center px-2 py-2.5 font-mono text-xs ${evColor(horse.expected_value)}`}>
                          {horse.expected_value != null
                            ? (horse.expected_value >= 0 ? "+" : "") + horse.expected_value.toFixed(3)
                            : "—"}
                        </td>
                        <td className="text-center px-2 py-2.5 text-gray-300 font-mono text-xs">
                          {horse.bet_fraction != null && horse.bet_fraction > 0
                            ? horse.bet_fraction.toFixed(1) + "%"
                            : "—"}
                        </td>
                      </>
                    )}
                    {oddsAvailable && (
                      <td className="text-center px-2 py-2.5">
                        {horse.should_bet ? (
                          <span className="bg-green-600 text-white text-xs font-bold px-2 py-0.5 rounded">
                            BET
                          </span>
                        ) : (
                          <span className="text-gray-600 text-xs">—</span>
                        )}
                      </td>
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
          <div className="px-4 py-3 bg-green-950/40 border-t border-green-900/40 flex items-center justify-between">
            <div>
              <span className="text-green-400 font-semibold">★ {best.name}</span>
              {best.name_ch && (
                <span className="text-green-600 text-sm ml-1">{best.name_ch}</span>
              )}
              <span className="text-gray-400 text-sm ml-2">
                {pct(best.win_prob)} win probability
                {best.win_odds != null && ` · odds ${best.win_odds.toFixed(1)}`}
                {best.expected_value != null && ` · EV ${best.expected_value >= 0 ? "+" : ""}${best.expected_value.toFixed(3)}`}
              </span>
            </div>
            {best.bet_fraction != null && best.bet_fraction > 0 && (
              <div className="text-right">
                <span className="text-green-300 font-bold text-lg">{best.bet_fraction.toFixed(1)}%</span>
                <p className="text-gray-500 text-xs">of bankroll</p>
              </div>
            )}
          </div>
        )
      })()}

      {/* Odds not yet available notice */}
      {!oddsAvailable && (
        <div className="px-4 py-2 bg-yellow-950/20 border-t border-yellow-900/20 text-yellow-600 text-xs">
          Odds not yet published — probabilities only. Re-fetch once HKJC posts odds.
        </div>
      )}
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
  const oddsReady = result?.races.some((r) =>
    r.horses.some((h) => h.win_odds !== null)
  ) ?? false

  return (
    <div className="min-h-screen bg-gray-950">
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center gap-4">
          <span className="text-xl font-bold text-white flex items-center gap-2">
            🏇 HKJC Predictor
          </span>

          <div className="flex items-center gap-2 ml-2">
            <input
              type="date"
              value={meetingDate}
              onChange={(e) => setMeetingDate(e.target.value)}
              className="bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <select
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              className="bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="ST">SHA TIN (ST)</option>
              <option value="HV">HAPPY VALLEY (HV)</option>
            </select>
          </div>

          <button
            onClick={fetchPredictions}
            disabled={loading || !meetingDate}
            className="bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-4 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-2"
          >
            {loading ? (
              <>
                <span className="animate-spin text-base">⟳</span> {status || "Fetching…"}
              </>
            ) : (
              <>⟳ Fetch Predictions</>
            )}
          </button>

          <div className="ml-auto flex items-center gap-3">
            {lastFetched && (
              <span className="text-gray-500 text-xs hidden sm:block">
                Updated {lastFetched}
              </span>
            )}
            <button
              onClick={handleLogout}
              className="text-gray-400 hover:text-white text-sm transition-colors"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────────────────── */}
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        {/* Summary bar */}
        {result && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-3 flex flex-wrap items-center gap-6 text-sm">
            <div>
              <span className="text-gray-400">Meeting </span>
              <span className="text-white font-semibold">
                {result.date} @ {result.venue}
              </span>
            </div>
            <div>
              <span className="text-gray-400">Races </span>
              <span className="text-white font-semibold">{result.races.length}</span>
            </div>
            <div>
              <span className="text-gray-400">Recommended bets </span>
              <span className={betsTotal > 0 ? "text-green-400 font-semibold" : "text-gray-400"}>
                {betsTotal}
              </span>
            </div>
            {!oddsReady && (
              <div className="text-yellow-500 text-xs bg-yellow-950/30 border border-yellow-900/30 px-3 py-1 rounded-full">
                ⚠ Odds not published yet — bet sizing unavailable
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-950/40 border border-red-900/40 text-red-300 rounded-xl px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* Empty state */}
        {!result && !loading && !error && (
          <div className="text-center py-20 text-gray-500">
            <div className="text-5xl mb-4">🏇</div>
            <p className="text-lg">Select a date and click <strong className="text-gray-300">Fetch Predictions</strong></p>
            <p className="text-sm mt-1">Race cards are usually published the day before the meeting.</p>
          </div>
        )}

        {/* Message from API (e.g. no races found) */}
        {result?.message && (
          <div className="bg-yellow-950/30 border border-yellow-900/30 text-yellow-400 rounded-xl px-4 py-3 text-sm">
            {result.message}
          </div>
        )}

        {/* Race cards */}
        {result?.races.map((race) => (
          <RaceCard key={race.race_no} race={race} />
        ))}
      </main>
    </div>
  )
}
