import type { Config } from "tailwindcss"

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        line: "var(--border)",
        "line-soft": "var(--border-soft)",
        ink: "var(--text)",
        "ink-muted": "var(--text-muted)",
        "ink-dim": "var(--text-dim)",
        accent: "var(--accent)",
        "accent-strong": "var(--accent-strong)",
        info: "var(--info)",
        brand: "var(--purple)",
        danger: "var(--danger)",
        warn: "var(--warn)",
      },
    },
  },
  plugins: [