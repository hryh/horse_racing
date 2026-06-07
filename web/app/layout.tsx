import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "HKJC Racing Predictor",
  description: "Private horse racing prediction dashboard",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Inter loaded at runtime; falls back to system fonts if unreachable */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen text-[var(--text)] antialiased font-sans">
        {children}
      </body>
    </html>
  )
}
