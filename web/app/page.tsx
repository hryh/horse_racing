"use client"

import { useState, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { TrophyIcon, LockIcon, SpinnerIcon, ArrowRightIcon, AlertIcon } from "./components/icons"

function LoginForm() {
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const next = searchParams.get("next") ?? "/dashboard"

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError("")

    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })

    if (res.ok) {
      router.push(next)
    } else {
      const data = await res.json()
      setError(data.error ?? "Incorrect password")
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm animate-fade-up">
        {/* Brand */}
        <div className="flex flex-col items-center text-center mb-8">
          <div className="relative mb-5">
            <div className="absolute inset-0 rounded-2xl bg-accent/20 blur-2xl" />
            <div className="relative flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-2 border border-line text-accent">
              <TrophyIcon className="text-3xl" />
            </div>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">HKJC Predictor</h1>
          <p className="text-ink-muted text-sm mt-1.5">Private prediction dashboard</p>
        </div>

        {/* Card */}
        <div className="surface-card glow-accent p-7">
          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block">
              <span className="flex items-center gap-1.5 text-xs font-medium text-ink-muted mb-2">
                <LockIcon className="text-sm" /> Access password
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                autoFocus
                className="field w-full px-4 py-3 text-sm placeholder:text-ink-dim"
              />
            </label>

            {error && (
              <p className="flex items-center gap-1.5 text-danger text-sm">
                <AlertIcon className="text-base shrink-0" /> {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="btn-accent w-full py-3 text-sm flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <SpinnerIcon className="text-base animate-spin-smooth" /> Signing in…
                </>
              ) : (
                <>
                  Enter <ArrowRightIcon className="text-base" />
                </>
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-ink-dim text-xs mt-6">
          Authorized access only
        </p>
      </div>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
