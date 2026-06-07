// Lightweight inline SVG icon set (no external dependency).
// All icons inherit currentColor and accept standard SVG props.

import type { SVGProps } from "react"

type IconProps = SVGProps<SVGSVGElement>

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
}

export function TrophyIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  )
}

export function StarIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <path d="M12 2.5l2.9 5.88 6.5.94-4.7 4.58 1.11 6.47L12 17.83l-5.81 3.06 1.11-6.47-4.7-4.58 6.5-.94L12 2.5Z" />
    </svg>
  )
}

export function StarFilledIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em" {...props}>
      <path d="M12 2.5l2.9 5.88 6.5.94-4.7 4.58 1.11 6.47L12 17.83l-5.81 3.06 1.11-6.47-4.7-4.58 6.5-.94L12 2.5Z" />
    </svg>
  )
}

export function ChartIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <path d="M3 3v18h18" />
      <rect x="7" y="11" width="3" height="6" rx="0.5" />
      <rect x="12" y="7" width="3" height="10" rx="0.5" />
      <rect x="17" y="13" width="3" height="4" rx="0.5" />
    </svg>
  )
}

export function TableIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
      <path d="M9 3v18" />
    </svg>
  )
}

export function AlertIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  )
}

export function LogoutIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}

export function LockIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      <path d="M12 15v2" />
    </svg>
  )
}

export function CalendarIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </svg>
  )
}

export function FilterIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3Z" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function TargetIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function LayersIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  )
}

export function SpinnerIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" width="1em" height="1em" {...props}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <svg {...base} width="1em" height="1em" {...props}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}
