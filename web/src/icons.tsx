import type { ReactNode, SVGProps } from 'react'

function Svg({
  children,
  size = 18,
  strokeWidth = 1.7,
  ...rest
}: SVGProps<SVGSVGElement> & { children: ReactNode; size?: number; strokeWidth?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  )
}

type P = { size?: number; strokeWidth?: number } & SVGProps<SVGSVGElement>

export const ISun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="13" r="4" />
    <path d="M12 2v3M4.5 6.5l1.5 1.5M2 14h2M22 14h-2M19.5 6.5 18 8" />
    <path d="M3 20h18" />
  </Svg>
)
export const IPipeline = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="4.5" height="16" rx="1" />
    <rect x="9.75" y="4" width="4.5" height="10" rx="1" />
    <rect x="16.5" y="4" width="4.5" height="13" rx="1" />
  </Svg>
)
export const IList = (p: P) => (
  <Svg {...p}>
    <path d="M8 6h13M8 12h13M8 18h13" />
    <path d="M3.2 6h.01M3.2 12h.01M3.2 18h.01" />
  </Svg>
)
export const IChart = (p: P) => (
  <Svg {...p}>
    <path d="M3 3v18h18" />
    <path d="M7 15l3.2-3.4 2.6 2.2L18 8" />
  </Svg>
)
export const ISliders = (p: P) => (
  <Svg {...p}>
    <path d="M4 21v-6M4 11V3M12 21v-9M12 8V3M20 21v-4M20 13V3M1 15h6M9 8h6M17 13h6" />
  </Svg>
)
export const ISearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
)
export const IPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const IX = (p: P) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
)
export const IChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
)
export const IChevronUp = (p: P) => (
  <Svg {...p}>
    <path d="m18 15-6-6-6 6" />
  </Svg>
)
export const ICheck = (p: P) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
)
export const IFilter = (p: P) => (
  <Svg {...p}>
    <path d="M3 5h18M6 12h12M10 19h4" />
  </Svg>
)
export const IColumns = (p: P) => (
  <Svg {...p}>
    <path d="M9 3v18M3 9h18" />
  </Svg>
)
export const IDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </Svg>
)
export const ICopy = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Svg>
)
export const ISend = (p: P) => (
  <Svg {...p}>
    <path d="m22 2-7 20-4-9-9-4z" />
    <path d="M22 2 11 13" />
  </Svg>
)
export const ICalendar = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </Svg>
)
export const IWarning = (p: P) => (
  <Svg {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
)
export const IZap = (p: P) => (
  <Svg {...p}>
    <path d="M13 2 3 14h8l-1 8 10-12h-8z" />
  </Svg>
)
