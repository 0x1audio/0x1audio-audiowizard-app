import icon from "../icon.svg"
import { Wordmark } from "./wordmark.tsx"

// One beam of sound goes into the prism and comes out as three: pitch, formant,
// and tempo, each free to move on its own.
const prism = "M452 16 508 124H396Z"
const beams = [
  { color: "var(--beam-pitch)", points: "478,62 480,67 640,8 640,30" },
  { color: "var(--beam-formant)", points: "481,69 483,75 640,62 640,84" },
  { color: "var(--beam-tempo)", points: "484,77 486,82 640,116 640,140" },
]
const sparkles = [
  { x: 318, y: 34, r: 5 },
  { x: 560, y: 128, r: 3.5 },
  { x: 372, y: 118, r: 3 },
  { x: 604, y: 40, r: 2.5 },
]

function star(x: number, y: number, r: number) {
  const k = r * 0.22
  return `M${x} ${y - r}Q${x + k} ${y - k} ${x + r} ${y}Q${x + k} ${y + k} ${x} ${y + r}Q${x - k} ${y + k} ${x - r} ${y}Q${x - k} ${y - k} ${x} ${y - r}Z`
}

export function Hero() {
  return (
    <header className="relative isolate h-36 overflow-hidden rounded-3xl bg-[linear-gradient(120deg,var(--hero-from),var(--hero-to))] shadow-sm max-sm:h-32">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_110%_at_74%_55%,var(--hero-glow),transparent_70%)]" />
      <svg className="pointer-events-none absolute inset-y-0 right-0 h-full w-auto max-sm:-right-24" viewBox="0 0 640 144" aria-hidden>
        <defs>
          <linearGradient id="wizard-in" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--hero-beam)" stopOpacity="0" />
            <stop offset="1" stopColor="var(--hero-beam)" stopOpacity="0.9" />
          </linearGradient>
          <linearGradient id="wizard-out" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="white" stopOpacity="1" />
            <stop offset="1" stopColor="white" stopOpacity="0.35" />
          </linearGradient>
          <mask id="wizard-fade" maskUnits="userSpaceOnUse" x="470" y="0" width="170" height="144">
            <rect x="470" width="170" height="144" fill="url(#wizard-out)" />
          </mask>
          <filter id="wizard-glow" x="-20%" y="-60%" width="140%" height="220%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>
        <path d="M300 101 419 82" stroke="url(#wizard-in)" strokeWidth="3" strokeLinecap="round" />
        <g mask="url(#wizard-fade)">
          <g filter="url(#wizard-glow)" className="opacity-0 dark:opacity-80">
            {beams.map((beam) => (
              <polygon key={beam.points} points={beam.points} fill={beam.color} />
            ))}
          </g>
          {beams.map((beam) => (
            <polygon key={beam.points} points={beam.points} fill={beam.color} />
          ))}
        </g>
        <path d={prism} fill="var(--hero-prism)" fillOpacity="0.08" stroke="var(--hero-prism)" strokeWidth="3" strokeLinejoin="round" />
        <g fill="var(--hero-prism)">
          {sparkles.map((spark) => (
            <path key={spark.x} d={star(spark.x, spark.y, spark.r)} opacity="0.7" />
          ))}
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-y-0 left-0 hidden w-3/5 bg-[linear-gradient(90deg,var(--hero-from)_60%,transparent)] max-sm:block" />
      <Grain />
      <div className="relative flex h-full flex-col justify-center gap-2.5 px-8 max-sm:px-6">
        <h1 className="flex items-center gap-3 text-(--hero-ink)">
          <img src={icon} alt="" className="size-10 rounded-[10px] shadow-sm" />
          <Wordmark className="h-7 w-auto max-sm:h-6" />
        </h1>
        <p className="text-sm text-(--hero-muted) max-sm:max-w-60">Change pitch, formant, and tempo, each on its own.</p>
      </div>
    </header>
  )
}

// A fine grain over the band keeps its soft gradients from banding.
function Grain() {
  return (
    <svg className="pointer-events-none absolute inset-0 size-full opacity-[0.1] mix-blend-soft-light" aria-hidden>
      <filter id="wizard-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#wizard-grain)" />
    </svg>
  )
}
