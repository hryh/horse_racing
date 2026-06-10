"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import {
  RefreshIcon, SpinnerIcon, AlertIcon, StarFilledIcon, TargetIcon,
} from "../components/icons"

// ── Types ──────────────────────────────────────────────────────────────────

interface StakeTip {
  rank: number
  name: string
  draw: number | null
  odds: number | null
}
interface StakeRunner {
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
interface StakeRace {
  raceNo: number
  url: string
  title: string | null
  tips: StakeTip[]
  tipsComment: string | null
  runners: StakeRunner[]
}
interface StakeResponse {
  date: string
  venue: string
  source: string
  discovered: number
  races: StakeRace[]
  error?: string
  note?: string
  stakeUrl?: string
}

interface ModelHorse {
  name: string
  win_prob: number
  win_odds: number | null
  expected_value: number | null
  should_bet: boolean
  bet_fraction: number | null
}
interface ModelRace {
  race_no: number
  best_bet: string | null
  horses: ModelHorse[]
}
interface ModelResult {
  races: ModelRace[]
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function norm(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function edge(prob: number | undefined, odds: number | null): number | null {
  if (prob == null || odds == null || odds <= 0) return null
  return prob * odds - 1
}

function fmtOdds(v: number | null): string {
  return v == null ? "—" : v.toFixed(2)
}

// ── Cloudflare fallback: model-based summary ────────────────────────────────
function ModelSummary({ model, date, stakeUrl }: {
  model: ModelResult | null
  date: string
  stakeUrl?: string
}) {
  const stakeLink = stakeUrl || "https://stake.com/sports/racing/horse-racing/asia"
  const bets = model?.races
    .filter((r) => r.best_bet !== null)
    .map((r) => {
      const best = r.horses.find((h) => h.name === r.best_bet)
      return { race_no: r.race_no, horse: best, race: r }
    })
    .filter((b) => b.horse != null) ?? []

  return (
    <div className="space-y-4 animate-fade-up">
      {/* Blocked notice */}
      <div className="surface-card px-4 sm:px-5 py-4 border-warn/20 bg-warn/[0.04]">
        <div className="flex items-start gap-3">
          <AlertIcon className="text-warn text-base mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm text-ink font-medium">Stake is Cloudflare-protected</p>
            <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">
              Server-side scraping is blocked. Open Stake directly in your browser to see
              RaceLab tips and live Stake odds for {date}.
            </p>
            <a
              href={stakeLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 mt-2.5 text-xs font-medium text-accent hover:text-accent/80 transition-colors"
            >
              Open {date} on Stake ↗
            </a>
          </div>
        </div>
      </div>

      {/* Show model bets as a reference while checking Stake manually */}
      {model && bets.length > 0 && (
        <div className="surface-card overflow-hidden">
          <div className="px-4 sm:px-5 py-3 border-b border-line bg-surface-2/60">
            <p className="text-[11px] uppercase tracking-wider text-ink-dim font-semibold">
              Model bets — cross-reference with Stake
            </p>
          </div>
          <div className="divide-y divide-line-soft">
            {bets.map(({ race_no, horse }) => {
              if (!horse) return null
              const ev = horse.expected_value
              return (
                <div key={race_no} className="px-4 sm:px-5 py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-ink-muted bg-surface-2 border border-line rounded px-1.5 py-0.5">
                        R{race_no}
                      </span>
                      <StarFilledIcon className="text-accent text-xs shrink-0" />
                      <span className="text-sm font-semibold text-accent truncate">{horse.name}</span>
                    </div>
                    <div className="text-xs text-ink-muted mt-0.5 flex items-center gap-3 flex-wrap">
                      <span>{(horse.win_prob * 100).toFixed(1)}% win</span>
                      {horse.win_odds != null && <span>HKJC @{horse.win_odds.toFixed(1)}</span>}
                      {ev != null && (
                        <span className={ev >= 0 ? "text-accent" : "text-danger"}>
                          EV {ev >= 0 ? "+" : ""}{ev.toFixed(3)}
                        </span>
                      )}
                    </div>
                  </div>
                  {horse.bet_fraction != null && horse.bet_fraction > 0 && (
                    <div className="text-right shrink-0">
                      <span className="text-accent font-bold">{horse.bet_fraction.toFixed(1)}%</span>
                      <p className="text-ink-dim text-[10px]">bankroll</p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {model && bets.length === 0 && (
        <p className="text-center text-ink-dim text-sm py-8">
          No model bets for this meeting. Fetch predictions first.
        </p>
      )}

      {!model && (
        <p className="text-center text-ink-dim text-sm py-8">
          Fetch predictions first, then cross-reference with Stake manually.
        </p>
      )}
    </div>
  )
}

// ── Component ───────────────────────────────────────────────────────────────

export default function StakeView({
  date,
  venue,
  model,
}: {
  date: string
  venue: string
  model: ModelResult | null
}) {
  const [data, setData] = useState<StakeResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    if (!date) return
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`/api/stake?date=${date}&venue=${venue}`)
      const body: StakeResponse = await res.json()
      if (!res.ok && !body.error) throw new Error(`HTTP ${res.status}`)
      setData(body)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [date, venue])

  useEffect(() => {
    if (date && !data && !loading) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, venue])

  const modelByRace = useMemo(() => {
    const map = new Map<number, Map<string, { prob: number; isBest: boolean; shouldBet: boolean }>>()
    if (!model) return map
    for (const r of model.races) {
      const inner = new Map<string, { prob: number; isBest: boolean; shouldBet: boolean }>()
      const bestNorm = r.best_bet ? norm(r.best_bet) : null
      for (const h of r.horses) {
        inner.set(norm(h.name), {
          prob: h.win_prob,
          isBest: bestNorm != null && norm(h.name) === bestNorm,
          shouldBet: h.should_bet,
        })
      }
      map.set(r.race_no, inner)
    }
    return map
  }, [model])

  // Cloudflare block — show fallback UI immediately
  if (data?.error === "cloudflare_blocked") {
    return <ModelSummary model={model} date={date} stakeUrl={data.stakeUrl} />
  }

  return (
    <div className="space-y-4">
      {/* Control bar */}
      <div className="surface-card px-4 sm:px-5 py-4 flex flex-wrap items-center gap-x-6 gap-y-3 animate-fade-up">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-dim">Source</div>
          <div className="text-sm text-ink font-medium">Stake · RaceLab tips &amp; odds</div>
        </div>
        {data && !data.error && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-dim">Races found</div>
            <div className="text-sm text-ink font-medium tabular-nums">{data.discovered}</div>
          </div>
        )}
        {data?.stakeUrl && (
          <a
            href={data.stakeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-ink-dim hover:text-accent transition-colors"
          >
            Stake ↗
          </a>
        )}
        <button
          onClick={load}
          disabled={loading || !date}
          className="btn-accent px-4 py-1.5 text-sm flex items-center gap-2 ml-auto"
        >
          {loading ? (
            <>
              <SpinnerIcon className="text-base animate-spin-smooth" /> Scraping…
            </>
          ) : (
            <>
              <RefreshIcon className="text-base" /> {data ? "Refresh" : "Load Stake"}
            </>
          )}
        </button>
      </div>

      {/* Explainer */}
      <p className="text-xs text-ink-dim px-1 -mt-1">
        Win % is from your model. <span className="text-accent">Edge</span> = model win % × Stake win odds − 1
        (positive ⇒ Stake is paying more than your model thinks the horse is worth).
        <StarFilledIcon className="text-accent text-xs inline-block mx-0.5 align-[-1px]" /> marks your model&apos;s best bet.
      </p>

      {error && (
        <div className="surface-card border-danger/30 bg-danger/[0.06] text-danger px-4 py-3 text-sm flex items-center gap-2">
          <AlertIcon className="text-base shrink-0" /> {error}
        </div>
      )}

      {/* Non-cloudflare errors */}
      {data?.error && data.error !== "cloudflare_blocked" && (
        <div className="surface-card border-warn/25 bg-warn/[0.06] text-warn px-4 py-3 text-sm flex items-start gap-2">
          <AlertIcon className="text-base shrink-0 mt-0.5" />
          <div className="min-w-0">
            <span>{data.note || data.error}</span>
            {data.stakeUrl && (
              <a
                href={data.stakeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block mt-1 text-xs text-accent hover:text-accent/80 transition-colors"
              >
                Check on Stake ↗
              </a>
            )}
          </div>
        </div>
      )}

      {loading && !data && (
        <div className="text-center py-20 text-ink-muted animate-fade-up">
          <SpinnerIcon className="text-4xl text-accent animate-spin-smooth mx-auto mb-4" />
          <p className="text-sm">Scraping Stake race cards…</p>
        </div>
      )}

      {data && !data.error && data.races.length === 0 && (
        <div className="text-center py-16 text-ink-muted">No race data parsed from Stake.</div>
      )}

      {data?.races.map((race) => {
        const ml = modelByRace.get(race.raceNo)
        const topTip = race.tips[0]
        const modelBest = model?.races.find((r) => r.race_no === race.raceNo)?.best_bet ?? null
        const disagree =
          topTip && modelBest && norm(topTip.name) !== norm(modelBest)
        return (
          <div key={race.raceNo} className="surface-card overflow-hidden animate-fade-up">
            {/* Race header */}
            <div className="px-4 sm:px-5 py-3 border-b border-line flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center justify-center min-w-7 h-7 px-2 rounded-lg bg-surface-2 border border-line text-accent text-sm font-semibold tabular-nums">
                R{race.raceNo}
              </span>
              <span className="text-sm text-ink font-medium truncate min-w-0">
                {race.title || "Race " + race.raceNo}
              </span>
              <a
                href={race.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-xs text-ink-dim hover:text-accent transition-colors shrink-0"
              >
                Stake ↗
              </a>
            </div>

            {/* RaceLab tips */}
            {race.tips.length > 0 && (
              <div className="px-4 sm:px-5 py-3 border-b border-line bg-bg/40">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <TargetIcon className="text-brand text-sm" />
                  <span className="text-[11px] uppercase tracking-wide text-ink-dim">RaceLab tips</span>
                  {disagree && (
                    <span className="chip text-warn border-warn/30 text-[11px]">
                      <AlertIcon className="text-[11px]" /> differs from your best bet
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {race.tips.map((t) => {
                    const isModelBest = modelBest && norm(t.name) === norm(modelBest)
                    return (
                      <span
                        key={t.rank}
                        className={[
                          "inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border tabular-nums",
                          isModelBest
                            ? "bg-accent/15 border-accent/30 text-accent"
                            : "bg-surface-2 border-line text-ink-muted",
                        ].join(" ")}
                      >
                        <span className="text-ink-dim">{t.rank}.</span>
                        {isModelBest && <StarFilledIcon className="text-[11px]" />}
                        <span className="text-ink">{t.name}</span>
                        {t.odds != null && <span className="text-ink-dim">@{t.odds.toFixed(1)}</span>}
                      </span>
                    )
                  })}
                </div>
                {race.tipsComment && (
                  <p className="text-xs text-ink-dim mt-2 leading-relaxed">{race.tipsComment}</p>
                )}
              </div>
            )}

            {/* Runners table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-ink-dim border-b border-line">
                    <th className="text-left font-medium px-3 py-2">#</th>
                    <th className="text-left font-medium px-3 py-2">Horse</th>
                    <th className="text-right font-medium px-3 py-2 hidden sm:table-cell">Dr</th>
                    <th className="text-right font-medium px-3 py-2">Win</th>
                    <th className="text-right font-medium px-3 py-2 hidden sm:table-cell">Plc</th>
                    <th className="text-right font-medium px-3 py-2">Model %</th>
                    <th className="text-right font-medium px-3 py-2">Edge</th>
                  </tr>
                </thead>
                <tbody>
                  {race.runners.map((r, i) => {
                    const mh = ml?.get(norm(r.name))
                    const e = edge(mh?.prob, r.win)
                    return (
                      <tr
                        key={`${r.no ?? "x"}-${i}`}
                        className="border-b border-line/60 last:border-0 hover:bg-surface-2/40 transition-colors"
                      >
                        <td className="px-3 py-2 text-ink-dim tabular-nums">{r.no ?? "—"}</td>
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-1.5">
                            {mh?.isBest && <StarFilledIcon className="text-accent text-xs shrink-0" />}
                            <span className={mh?.shouldBet ? "text-ink font-medium" : "text-ink"}>
                              {r.name}
                            </span>
                            {r.runStyle && r.runStyle !== "No Data" && (
                              <span className="text-[10px] text-ink-dim border border-line rounded px-1 py-px hidden sm:inline">
                                {r.runStyle}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-ink-muted tabular-nums hidden sm:table-cell">
                          {r.draw ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-ink tabular-nums">{fmtOdds(r.win)}</td>
                        <td className="px-3 py-2 text-right text-ink-muted tabular-nums hidden sm:table-cell">
                          {fmtOdds(r.place)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {mh
                            ? <span className="text-ink">{(mh.prob * 100).toFixed(1)}%</span>
                            : <span className="text-ink-dim">—</span>
                          }
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {e == null ? (
                            <span className="text-ink-dim">—</span>
                          ) : (
                            <span className={e > 0 ? "text-accent font-medium" : "text-ink-dim"}>
                              {e > 0 ? "+" : ""}{(e * 100).toFixed(0)}%
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {race.runners.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-4 text-center text-ink-dim text-xs">
                        No runner odds parsed for this race.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}
