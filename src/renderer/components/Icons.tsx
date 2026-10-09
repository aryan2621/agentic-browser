import type { ReactNode, SVGProps } from 'react'

function Svg({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const IconBack = () => (
  <Svg>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
)
export const IconForward = () => (
  <Svg>
    <path d="M9 18l6-6-6-6" />
  </Svg>
)
export const IconReload = () => (
  <Svg>
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </Svg>
)
export const IconStop = () => (
  <Svg>
    <path d="M18 6L6 18M6 6l12 12" />
  </Svg>
)
export const IconPlus = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const IconClose = () => (
  <Svg width="12" height="12">
    <path d="M18 6L6 18M6 6l12 12" />
  </Svg>
)
/** Radiating spark used for AI actions. */
export const IconSparkle = ({ size = 16 }: { size?: number }) => (
  <Svg width={size} height={size} strokeWidth="2.2">
    <path d="M12 3v5.5M12 15.5V21M3 12h5.5M15.5 12H21M5.6 5.6l3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9" />
  </Svg>
)
export const IconSettings = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
)
export const IconGlobe = () => (
  <Svg>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
  </Svg>
)
export const IconLock = () => (
  <Svg width="14" height="14">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
)
export const IconCopy = () => (
  <Svg width="14" height="14">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Svg>
)
export const IconDownload = () => (
  <Svg width="14" height="14">
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </Svg>
)
export const IconSend = () => (
  <Svg>
    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
  </Svg>
)
export const IconRobot = () => (
  <Svg width="12" height="12">
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <path d="M12 4v4M9 13h.01M15 13h.01" />
  </Svg>
)
export const IconWarning = () => (
  <Svg width="14" height="14">
    <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01" />
  </Svg>
)
export const IconSidebar = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </Svg>
)
export const IconMic = () => (
  <Svg>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
)
export const IconChevronDown = () => (
  <Svg>
    <path d="M6 9l6 6 6-6" />
  </Svg>
)
export const IconCheck = () => (
  <Svg>
    <path d="M5 12l5 5 9-10" />
  </Svg>
)
export const IconArrowUp = () => (
  <Svg>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
)
export const IconSearch = () => (
  <Svg>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Svg>
)
export const IconSpeaker = () => (
  <Svg width="14" height="14">
    <path d="M11 5L6 9H3v6h3l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </Svg>
)
export const IconSpeakerMuted = () => (
  <Svg width="14" height="14">
    <path d="M11 5L6 9H3v6h3l5 4z" />
    <path d="M22 9l-6 6M16 9l6 6" />
  </Svg>
)
export const IconFolder = () => (
  <Svg width="14" height="14">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
)
export const IconPause = () => (
  <Svg width="14" height="14">
    <path d="M9 5v14M15 5v14" />
  </Svg>
)
export const IconPlay = () => (
  <Svg width="14" height="14">
    <path d="M7 5l12 7-12 7z" />
  </Svg>
)
export const IconChevronUp = () => (
  <Svg width="14" height="14">
    <path d="M18 15l-6-6-6 6" />
  </Svg>
)
export const IconTrash = () => (
  <Svg width="14" height="14">
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </Svg>
)
export const IconExternal = () => (
  <Svg width="12" height="12">
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Svg>
)
export const IconHistory = () => (
  <Svg>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </Svg>
)
export const IconStar = ({ filled = false }: { filled?: boolean }) => (
  <Svg fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
  </Svg>
)
export const IconMore = () => (
  <Svg>
    <circle cx="12" cy="5" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="19" r="1.2" fill="currentColor" />
  </Svg>
)
export const IconShield = () => (
  <Svg>
    <path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" />
  </Svg>
)
export const IconBolt = () => (
  <Svg>
    <path d="M13 3L5 14h6l-1 7 8-11h-6z" />
  </Svg>
)
export const IconInfo = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
)
