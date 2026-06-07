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
          href="https: